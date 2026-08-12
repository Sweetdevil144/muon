import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpVendorIo, VendorRunResult } from "@muon/client/mcp-vendor-config";
import { attachedCoordinatorCapabilityFilePath } from "@muon/client/attached-coordinator-capability";
import type {
  AttachCoordinatorApiClient,
  DetachCoordinatorApiClient,
} from "@muon/client/attached-coordinator-flow";
import { attachMcpCoordinator, detachMcpCoordinator } from "../src/lib/mcp-bridge.js";

/**
 * ADR-0028 Tier C — the main-process side of the Connections row's
 * Attach/Detach controls (Batch 3). Both functions delegate wholly to the
 * SAME `attachCoordinatorFlow`/`detachCoordinatorFlow` `muon mcp attach|
 * detach` calls, so this file's job is narrower than mcp-bridge.test.ts's:
 * prove the IPC-facing result is a NARROWED, token-free projection, and that
 * nothing here touches the operator's real vendor configs.
 *
 * Same structural safety rule as mcp-bridge.test.ts: every root is a fresh
 * mkdtemp with `redirectVendorConfigDirs: true`, and the fake runner throws
 * on a spawn without it.
 */

const MCP_BIN = "/opt/muon/bin/muon-mcp";
const TOKEN = "d".repeat(64);

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
        return { code: 0, stdout: "Removed", stderr: "", spawnFailed: false };
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
      return { code: 0, stdout: "Added", stderr: "", spawnFailed: false };
    }
    throw new Error(`unexpected spawn: ${command}`);
  };
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

function io(): McpVendorIo {
  const home = tempDir("muon-desktop-attach-");
  return {
    roots: {
      home,
      configHome: path.join(home, ".config"),
      cwd: path.join(home, "repo"),
      redirectVendorConfigDirs: true,
    },
    run: fakeVendorRunner(),
    which: (command) =>
      command === "muon-mcp" ? MCP_BIN : `/usr/local/bin/${command}`,
    isExecutableFile: (p) => p === MCP_BIN,
  };
}

function fakeAttachClient(
  overrides: Partial<AttachCoordinatorApiClient> = {}
): AttachCoordinatorApiClient {
  return {
    createChat: async (input) => ({
      id: "chat-1",
      workspacePath: input.workspacePath,
      taskId: "task-1",
    }),
    archiveChat: async () => ({}),
    attachCoordinator: async (input) => ({
      job: { id: "job-1", workspacePath: "/repo" },
      chat: { id: input.chatId, taskId: "task-1", workspacePath: "/repo" },
      capability: {
        token: TOKEN,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
      attestation: { posture: "non-hermetic", claim: "external, human-started session" },
    }),
    detachCoordinator: async (jobId) => ({ detached: true, jobId }),
    listDispatchJobs: async () => [],
    ...overrides,
  };
}

describe("attachMcpCoordinator — the main-process side of the Connections Attach button", () => {
  it("attaches codex, and the IPC-facing result carries no field the token could hide in", async () => {
    const vendorIo = io();
    const dataDir = tempDir("muon-desktop-attach-data-");
    const result = await attachMcpCoordinator(
      "codex",
      { workspacePath: "/repo" },
      { io: vendorIo, client: fakeAttachClient(), apiBase: "http://127.0.0.1:4317", dataDir }
    );
    expect(result.kind).toBe("attached");
    if (result.kind !== "attached") return;
    expect(result).toEqual({
      kind: "attached",
      vendor: "codex",
      jobId: "job-1",
      chatId: "chat-1",
      workspacePath: "/repo",
      expiresAt: expect.any(String),
      attestation: { posture: "non-hermetic", claim: "external, human-started session" },
    });
    // Structurally: only these seven keys ever cross the bridge.
    expect(Object.keys(result).sort()).toEqual(
      [
        "attestation",
        "chatId",
        "expiresAt",
        "jobId",
        "kind",
        "vendor",
        "workspacePath",
      ].sort()
    );
    expect(JSON.stringify(result)).not.toContain(TOKEN);

    // And the file it wrote (never sent over IPC) does hold the token, at 0600.
    const capFile = attachedCoordinatorCapabilityFilePath("codex", dataDir);
    expect(fs.statSync(capFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(capFile, "utf8")).toContain(TOKEN);
  });

  it("refuses a non-coordinator vendor without calling the backend at all", async () => {
    const vendorIo = io();
    let attachCalled = false;
    const client = fakeAttachClient({
      attachCoordinator: async () => {
        attachCalled = true;
        throw new Error("should not be called");
      },
    });
    const result = await attachMcpCoordinator(
      "cursor",
      { workspacePath: "/repo" },
      { io: vendorIo, client, apiBase: "http://127.0.0.1:4317" }
    );
    expect(result.kind).toBe("refused");
    expect(attachCalled).toBe(false);
  });

  it("refuses an unknown vendor id", async () => {
    const vendorIo = io();
    const result = await attachMcpCoordinator(
      "fake" as never,
      { workspacePath: "/repo" },
      { io: vendorIo, client: fakeAttachClient(), apiBase: "http://127.0.0.1:4317" }
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toContain("does not manage an MCP entry");
  });

  it("surfaces a backend refusal (seat contention) as {kind: refused}, never a rejection", async () => {
    const vendorIo = io();
    const client = fakeAttachClient({
      attachCoordinator: async () => {
        throw new Error("409: codex already holds the coordinator seat");
      },
    });
    const result = await attachMcpCoordinator(
      "codex",
      { workspacePath: "/repo" },
      { io: vendorIo, client, apiBase: "http://127.0.0.1:4317" }
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toContain("already holds the coordinator seat");
  });
});

describe("detachMcpCoordinator — the main-process side of the Connections Detach button", () => {
  it("detaches, removes the capability file, and reverts the vendor config", async () => {
    const vendorIo = io();
    const dataDir = tempDir("muon-desktop-attach-data-");
    await attachMcpCoordinator(
      "codex",
      { workspacePath: "/repo" },
      { io: vendorIo, client: fakeAttachClient(), apiBase: "http://127.0.0.1:4317", dataDir }
    );

    let detachedJobId: string | null = null;
    const client: DetachCoordinatorApiClient = {
      detachCoordinator: async (jobId) => {
        detachedJobId = jobId;
        return { detached: true, jobId };
      },
      listDispatchJobs: async () => [],
    };
    const result = await detachMcpCoordinator("codex", { io: vendorIo, client, dataDir });
    expect(result.kind).toBe("detached");
    expect(result.jobId).toBe("job-1");
    expect(detachedJobId).toBe("job-1");
    expect(
      fs.existsSync(attachedCoordinatorCapabilityFilePath("codex", dataDir))
    ).toBe(false);
  });

  it("is idempotent: detaching with nothing attached reports not-attached, not an error", async () => {
    const vendorIo = io();
    const client: DetachCoordinatorApiClient = {
      detachCoordinator: async (jobId) => ({ detached: true, jobId }),
      listDispatchJobs: async () => [],
    };
    const result = await detachMcpCoordinator("codex", {
      io: vendorIo,
      client,
      dataDir: tempDir("muon-desktop-attach-data-"),
    });
    expect(result.kind).toBe("not-attached");
    expect(result.jobId).toBeNull();
  });

  it("preserves a partial backend cleanup verdict across the IPC projection", async () => {
    const vendorIo = io();
    const result = await detachMcpCoordinator("codex", {
      io: vendorIo,
      client: {
        detachCoordinator: async (jobId) => ({ detached: true, jobId }),
        listDispatchJobs: async () => {
          throw new Error("brain unavailable");
        },
      },
      dataDir: tempDir("muon-desktop-detach-partial-"),
    });
    expect(result.kind).toBe("partial");
    expect(result.notes.join(" ")).toContain("backend state is unknown");
  });

  it("refuses an unknown vendor id without touching the backend", async () => {
    const vendorIo = io();
    let called = false;
    const client: DetachCoordinatorApiClient = {
      detachCoordinator: async (jobId) => {
        called = true;
        return { detached: true, jobId };
      },
      listDispatchJobs: async () => {
        called = true;
        return [];
      },
    };
    const result = await detachMcpCoordinator("fake" as never, {
      io: vendorIo,
      client,
      dataDir: tempDir("muon-desktop-attach-data-"),
    });
    expect(result.kind).toBe("not-attached");
    expect(called).toBe(false);
  });
});
