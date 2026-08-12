import fs from "node:fs";
import path from "node:path";
import type { VendorRunResult } from "@muon/client/mcp-vendor-config";

/**
 * THE FAKE AGENT CLI, shared by every suite that installs MUON into one.
 *
 * It does what the real vendor binary does — writes the config file — because
 * a runner that returns success without writing lets a test prove an install
 * that never happened. Extracted rather than copied: two of these drift, and
 * the one that drifts is the one still asserting the old shape.
 */
export type Spawned = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
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

function ok(stdout: string): VendorRunResult {
  return { code: 0, stdout, stderr: "", spawnFailed: false };
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


export function fakeVendorRunner(spawns: Spawned[]) {
  return (
    command: string,
    args: readonly string[],
    extraEnv: Readonly<Record<string, string>>
  ): VendorRunResult => {
    spawns.push({ command, args: [...args], env: { ...extraEnv } });

    if (command === "claude") {
      const dir = extraEnv.CLAUDE_CONFIG_DIR;
      if (!dir) {
        throw new Error(
          "SAFETY: a test spawned `claude` with no CLAUDE_CONFIG_DIR override — it would have written the operator's real ~/.claude.json"
        );
      }
      const scope = args[args.indexOf("-s") + 1];
      const file =
        scope === "project"
          ? path.join(extraEnv.MUON_TEST_CWD ?? dir, ".mcp.json")
          : path.join(dir, ".claude.json");
      const doc = readJson(file);
      const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
      if (args[1] === "remove") {
        const wasThere = servers[args[2]!] !== undefined;
        delete servers[args[2]!];
        doc.mcpServers = servers;
        writeJson(file, doc);
        return wasThere
          ? ok("Removed MCP server")
          : {
              code: 1,
              stdout: `No MCP server named "${args[2]}" in ${scope} scope`,
              stderr: "",
              spawnFailed: false,
            };
      }
      if (servers[args[2]!] !== undefined) {
        return { code: 1, stdout: "MCP server muon already exists", stderr: "", spawnFailed: false };
      }
      const entryEnv: Record<string, string> = {};
      for (let index = 0; index < args.length - 1; index += 1) {
        if (args[index] !== "-e") continue;
        const pair = args[index + 1] ?? "";
        const split = pair.indexOf("=");
        if (split > 0) entryEnv[pair.slice(0, split)] = pair.slice(split + 1);
      }
      servers[args[2]!] = {
        type: "stdio",
        command: args[args.length - 1],
        args: [],
        env: entryEnv,
      };
      doc.mcpServers = servers;
      writeJson(file, doc);
      return ok("Added stdio MCP server muon");
    }

    if (command === "codex") {
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
      const stripped = stripTomlSection(stripTomlSection(existing, header), envHeader);
      if (args[1] === "remove") {
        writeText(file, stripped);
        return ok("Removed global MCP server");
      }
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
      return ok("Added global MCP server 'muon'.");
    }

    if (command === "cursor-agent") {
      // Measured: exits 0 even when logged OUT, so its exit code proves nothing.
      if (!extraEnv.HOME) {
        throw new Error("SAFETY: `cursor-agent` spawned with no HOME override");
      }
      return ok("MCP server 'muon' is already enabled and approved");
    }

    throw new Error(`unexpected spawn: ${command}`);
  };
}

