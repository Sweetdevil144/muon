import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMcpCommands } from "../src/commands/mcp.js";
import {
  type McpVendorIo,
  type VendorRunResult,
} from "@muon/client/mcp-vendor-config";
import { attachedCoordinatorCapabilityFilePath } from "@muon/client/attached-coordinator-capability";
import type { MuonApiClient } from "../src/lib/api-client.js";

/**
 * `muon mcp attach|detach` — ADR-0028 Tier C, CLI parity (Batch 3).
 *
 * Same safety rule as mcp-install.test.ts: every `McpVendorIo` here is rooted
 * at a fresh mkdtemp with `redirectVendorConfigDirs: true`, and the fake
 * vendor runner throws on a spawn without that override.
 */

const MCP_BIN = "/opt/muon/bin/muon-mcp";
const TOKEN = "t".repeat(64);

const tempRoots: string[] = [];
afterEach(() => {
  tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  tempRoots.length = 0;
  vi.restoreAllMocks();
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-mcp-attach-"));
  tempRoots.push(dir);
  return dir;
}

function fakeVendorRunner() {
  return (
    command: string,
    args: readonly string[],
    extraEnv: Readonly<Record<string, string>>
  ): VendorRunResult => {
    if (command === "codex") {
      const home = extraEnv.CODEX_HOME;
      if (!home) {
        throw new Error("SAFETY: `codex` spawned with no CODEX_HOME override");
      }
      const file = path.join(home, "config.toml");
      const header = `[mcp_servers.${args[2]}]`;
      const envHeader = `[mcp_servers.${args[2]}.env]`;
      const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const stripped = stripTomlSection(stripTomlSection(existing, header), envHeader);
      if (args[1] === "remove") {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, stripped);
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
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `${stripped}${stripped && !stripped.endsWith("\n") ? "\n" : ""}${header}\ncommand = ${JSON.stringify(args[args.length - 1])}\n${envLines.length > 0 ? `${envHeader}\n${envLines.join("\n")}\n` : ""}`
      );
      return ok("Added global MCP server 'muon'.");
    }
    throw new Error(`unexpected spawn: ${command}`);
  };
}

function ok(stdout: string): VendorRunResult {
  return { code: 0, stdout, stderr: "", spawnFailed: false };
}

function stripTomlSection(text: string, header: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return text;
  let end = start + 1;
  while (end < lines.length && !lines[end]!.trimStart().startsWith("[")) {
    end += 1;
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

type Harness = { io: McpVendorIo; home: string; dataDir: string };

function harness(): Harness {
  const home = tempHome();
  const dataDir = path.join(home, "data");
  return {
    home,
    dataDir,
    io: {
      roots: {
        home,
        configHome: path.join(home, ".config"),
        cwd: home,
        redirectVendorConfigDirs: true,
      },
      run: fakeVendorRunner(),
      which: (command) => `/usr/local/bin/${command}`,
      isExecutableFile: (p) => p === MCP_BIN,
    },
  };
}

function fakeClient(overrides: Record<string, unknown> = {}): MuonApiClient {
  return {
    createChat: async (input: { workspacePath: string }) => ({
      id: "chat-1",
      workspacePath: input.workspacePath,
      taskId: "task-1",
    }),
    archiveChat: async () => ({}),
    attachCoordinator: async (input: { vendor: string; chatId: string }) => ({
      job: { id: "job-1", workspacePath: "/repo" },
      chat: { id: input.chatId, taskId: "task-1", workspacePath: "/repo" },
      capability: {
        token: TOKEN,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
      attestation: { posture: "non-hermetic", claim: "external, human-started session" },
    }),
    detachCoordinator: async (jobId: string) => ({ detached: true, jobId }),
    listDispatchJobs: async () => [],
    getRunner: async () => ({ runner: null, live: true }),
    ...overrides,
  } as unknown as MuonApiClient;
}

function run(argv: string[], h: Harness, client: MuonApiClient) {
  const program = new Command();
  program.exitOverride();
  program.option("--api-base <url>", "");
  registerMcpCommands(program, { io: h.io, env: { MUON_DATA_DIR: h.dataDir } }, () => client);
  return program.parseAsync(["node", "muon", ...argv]);
}

async function withFakeEntrypoint<T>(fn: () => Promise<T>): Promise<T> {
  const argv = process.argv[1];
  process.argv[1] = "/opt/muon/bin/muon";
  try {
    return await fn();
  } finally {
    process.argv[1] = argv;
  }
}

describe("muon mcp attach", () => {
  it("attaches codex end to end: creates a chat, writes the 0600 capability file, registers attach mode, never prints the token", async () => {
    const h = harness();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await withFakeEntrypoint(() => run(["mcp", "attach", "codex"], h, fakeClient()));

    const text = out.mock.calls.map((call) => String(call[0])).join("");
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("attached Codex");
    expect(text).toContain("job-1");
    expect(text).toContain("chat-1");

    const capFile = attachedCoordinatorCapabilityFilePath("codex", h.dataDir);
    expect(fs.statSync(capFile).mode & 0o777).toBe(0o600);
    const capText = fs.readFileSync(capFile, "utf8");
    expect(capText).toContain(TOKEN);

    const toml = fs.readFileSync(path.join(h.home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('MUON_MCP_MODE = "attached-coordinator"');
    expect(toml).toContain(`MUON_ATTACHED_CAPABILITY_FILE = "${capFile}"`);
    expect(toml).not.toContain(TOKEN);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("--json prints the outcome as JSON and STILL never contains the token", async () => {
    const h = harness();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await withFakeEntrypoint(() =>
      run(["mcp", "attach", "codex", "--json"], h, fakeClient())
    );
    const text = out.mock.calls.map((call) => String(call[0])).join("");
    expect(text).not.toContain(TOKEN);
    const parsed = JSON.parse(text);
    expect(parsed.kind).toBe("attached");
    expect(parsed.jobId).toBe("job-1");
    expect(JSON.stringify(parsed)).not.toContain(TOKEN);
  });

  it("uses --chat instead of creating a new one", async () => {
    const h = harness();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let createChatCalled = false;
    const client = fakeClient({
      createChat: async () => {
        createChatCalled = true;
        throw new Error("should not be called");
      },
    });
    await withFakeEntrypoint(() =>
      run(["mcp", "attach", "codex", "--chat", "existing-chat"], h, client)
    );
    expect(createChatCalled).toBe(false);
    const capFile = attachedCoordinatorCapabilityFilePath("codex", h.dataDir);
    const capText = fs.readFileSync(capFile, "utf8");
    expect(capText).toContain("existing-chat");
  });

  it("refuses a vendor with no coordinator seat and touches nothing", async () => {
    const h = harness();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let attachCalled = false;
    const client = fakeClient({
      attachCoordinator: async () => {
        attachCalled = true;
        throw new Error("should not be called");
      },
    });
    await withFakeEntrypoint(() => run(["mcp", "attach", "cursor"], h, client));
    const text = err.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("does not hold MUON's coordinator seat");
    expect(attachCalled).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("refuses an unknown vendor", async () => {
    const h = harness();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await withFakeEntrypoint(() => run(["mcp", "attach", "nope"], h, fakeClient()));
    const text = err.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("Unknown vendor 'nope'");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("surfaces a refusal from the backend (e.g. seat contention) with exit code 1", async () => {
    const h = harness();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const client = fakeClient({
      attachCoordinator: async () => {
        throw new Error("409: codex already holds the coordinator seat on this chat");
      },
    });
    await withFakeEntrypoint(() => run(["mcp", "attach", "codex"], h, client));
    const text = err.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("Attach was refused");
    expect(text).toContain("already holds the coordinator seat");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(
      fs.existsSync(attachedCoordinatorCapabilityFilePath("codex", h.dataDir))
    ).toBe(false);
  });
});

describe("muon mcp detach", () => {
  async function attachFirst(h: Harness): Promise<string> {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await withFakeEntrypoint(() => run(["mcp", "attach", "codex"], h, fakeClient()));
    vi.restoreAllMocks();
    return "job-1";
  }

  it("detaches, removes the capability file, and reverts the vendor config to base", async () => {
    const h = harness();
    await attachFirst(h);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let detachedJobId: string | null = null;
    const client = fakeClient({
      detachCoordinator: async (jobId: string) => {
        detachedJobId = jobId;
        return { detached: true, jobId };
      },
    });
    await run(["mcp", "detach", "codex"], h, client);

    expect(detachedJobId).toBe("job-1");
    const text = out.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("detached Codex");
    expect(
      fs.existsSync(attachedCoordinatorCapabilityFilePath("codex", h.dataDir))
    ).toBe(false);
    const toml = fs.readFileSync(path.join(h.home, ".codex", "config.toml"), "utf8");
    expect(toml).not.toContain("MUON_MCP_MODE");
    expect(toml).not.toContain("MUON_ATTACHED_CAPABILITY_FILE");
    expect(toml).toContain("[mcp_servers.muon]");
  });

  it("reports nothing to detach when no seat is attached", async () => {
    const h = harness();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await run(["mcp", "detach", "codex"], h, fakeClient());
    const text = out.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("nothing to detach");
  });

  it("--json never contains a token even after a real attach", async () => {
    const h = harness();
    await attachFirst(h);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await run(["mcp", "detach", "codex", "--json"], h, fakeClient());
    const text = out.mock.calls.map((call) => String(call[0])).join("");
    expect(text).not.toContain(TOKEN);
    const parsed = JSON.parse(text);
    expect(parsed.kind).toBe("detached");
  });

  it("returns exit 1 and an incomplete verdict when backend detach is unconfirmed", async () => {
    const h = harness();
    await attachFirst(h);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await run(
      ["mcp", "detach", "codex"],
      h,
      fakeClient({
        detachCoordinator: async () => {
          throw new Error("brain unreachable");
        },
      })
    );

    const text = out.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("detach is incomplete");
    expect(text).toContain("brain unreachable");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
