import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachCoordinatorFlow,
  detachCoordinatorFlow,
  type AttachCoordinatorApiClient,
  type DetachCoordinatorApiClient,
} from "../src/attached-coordinator-flow.js";
import {
  readAttachedCoordinatorCapabilityFile,
  attachedCoordinatorCapabilityFilePath,
} from "../src/attached-coordinator-capability.js";
import {
  resolveInstallableVendor,
  type InstallableVendorSpec,
  type McpVendorIo,
  type VendorRunResult,
} from "../src/mcp-vendor-config.js";
import { MuonApiHttpError } from "../src/api-client.js";

// ── ADR-0028 Tier C: the shared attach/detach flow ───────────────────────────
//
// SAFETY RULE (mirrors mcp-vendor-config-attached.test.ts): every `McpVendorIo`
// here is rooted at a fresh mkdtemp with `redirectVendorConfigDirs: true`, and
// every fake vendor runner throws if handed a spawn without that override, so
// a regression that flipped the seam off fails loudly instead of silently
// writing into the operator's real ~/.codex.

const MCP_BIN = "/opt/muon/bin/muon-mcp";

const tempRoots: string[] = [];
afterEach(() => {
  tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  tempRoots.length = 0;
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-attach-flow-"));
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
        throw new Error(
          "SAFETY: a test spawned `codex` with no CODEX_HOME override"
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
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
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

function codexSpec(): InstallableVendorSpec {
  return resolveInstallableVendor("codex")!;
}

function fakeClient(
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
        token: "c".repeat(64),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
      attestation: {
        posture: "non-hermetic",
        claim: "external, human-started session",
      },
    }),
    detachCoordinator: async (jobId) => ({ detached: true, jobId }),
    listDispatchJobs: async () => [],
    ...overrides,
  };
}

describe("attachCoordinatorFlow", () => {
  it("attaches end to end: writes the capability file 0600 and the vendor config, never returns the token", async () => {
    const h = harness();
    const argv = process.argv[1];
    process.argv[1] = "/opt/muon/bin/muon";
    try {
      const result = await attachCoordinatorFlow({
        client: fakeClient(),
        io: h.io,
        apiBase: "http://127.0.0.1:4317",
        dataDir: h.dataDir,
        spec: codexSpec(),
        workspacePath: "/repo",
      });
      expect(result.kind).toBe("attached");
      if (result.kind !== "attached") return;

      // Never a token field, anywhere on the result — this is the exact
      // shape a desktop IPC handler may hand the renderer verbatim.
      expect(JSON.stringify(result)).not.toContain("c".repeat(64));
      expect(result.jobId).toBe("job-1");
      expect(result.chatId).toBe("chat-1");
      expect(result.chatTaskId).toBe("task-1");
      expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());

      const capFile = attachedCoordinatorCapabilityFilePath("codex", h.dataDir);
      expect(result.capabilityFilePath).toBe(capFile);
      expect(fs.statSync(capFile).mode & 0o777).toBe(0o600);
      const read = readAttachedCoordinatorCapabilityFile(capFile);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.capability.apiToken).toBe("c".repeat(64));
        expect(read.capability.delegationToken).toBe("c".repeat(64));
        expect(read.capability.jobId).toBe("job-1");
        expect(read.capability.chatId).toBe("chat-1");
      }

      const toml = fs.readFileSync(
        path.join(h.home, ".codex", "config.toml"),
        "utf8"
      );
      expect(toml).toContain('MUON_MCP_MODE = "attached-coordinator"');
      expect(toml).toContain(`MUON_ATTACHED_CAPABILITY_FILE = "${capFile}"`);
      expect(toml).not.toContain("c".repeat(64));
    } finally {
      process.argv[1] = argv;
    }
  });

  // P0-2 identity binding: the capability file names the verified operator.
  it("stamps the brain's verified GitHub login into the capability file", async () => {
    const h = harness();
    const argv = process.argv[1];
    process.argv[1] = "/opt/muon/bin/muon";
    try {
      const result = await attachCoordinatorFlow({
        client: fakeClient({
          getGitHubStatus: async () => ({ connected: true, login: "octocat" }),
        }),
        io: h.io,
        apiBase: "http://127.0.0.1:4317",
        dataDir: h.dataDir,
        spec: codexSpec(),
        workspacePath: "/repo",
      });
      expect(result.kind).toBe("attached");
      if (result.kind !== "attached") return;
      const read = readAttachedCoordinatorCapabilityFile(
        result.capabilityFilePath
      );
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.capability.operatorGitHubLogin).toBe("octocat");
      }
    } finally {
      process.argv[1] = argv;
    }
  });

  it("requireGitHubIdentity refuses BEFORE any chat or seat is created when identity is unknown", async () => {
    const h = harness();
    const argv = process.argv[1];
    process.argv[1] = "/opt/muon/bin/muon";
    const createChat = vi.fn();
    const attachCoordinator = vi.fn();
    try {
      const result = await attachCoordinatorFlow({
        client: fakeClient({
          // No getGitHubStatus at all — identity is UNKNOWN, which under the
          // requirement must refuse, never assume.
          createChat: createChat as never,
          attachCoordinator: attachCoordinator as never,
        }),
        io: h.io,
        apiBase: "http://127.0.0.1:4317",
        dataDir: h.dataDir,
        spec: codexSpec(),
        workspacePath: "/repo",
        requireGitHubIdentity: true,
      });
      expect(result.kind).toBe("refused");
      if (result.kind === "refused") {
        expect(result.reason).toMatch(/muon github login/);
      }
      expect(createChat).not.toHaveBeenCalled();
      expect(attachCoordinator).not.toHaveBeenCalled();
    } finally {
      process.argv[1] = argv;
    }
  });

  it("without the requirement, an unknown GitHub identity attaches with no stamp", async () => {
    const h = harness();
    const argv = process.argv[1];
    process.argv[1] = "/opt/muon/bin/muon";
    try {
      const result = await attachCoordinatorFlow({
        client: fakeClient({
          getGitHubStatus: async () => ({ connected: false }),
        }),
        io: h.io,
        apiBase: "http://127.0.0.1:4317",
        dataDir: h.dataDir,
        spec: codexSpec(),
        workspacePath: "/repo",
      });
      expect(result.kind).toBe("attached");
      if (result.kind !== "attached") return;
      const read = readAttachedCoordinatorCapabilityFile(
        result.capabilityFilePath
      );
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.capability.operatorGitHubLogin).toBeUndefined();
      }
    } finally {
      process.argv[1] = argv;
    }
  });

  it("creates a new chat when chatId is omitted", async () => {
    const h = harness();
    process.argv[1] = "/opt/muon/bin/muon";
    let createdWorkspace: string | undefined;
    const client = fakeClient({
      createChat: async (input) => {
        createdWorkspace = input.workspacePath;
        return { id: "fresh-chat", workspacePath: input.workspacePath, taskId: "task-9" };
      },
    });
    const result = await attachCoordinatorFlow({
      client,
      io: h.io,
      apiBase: "http://127.0.0.1:4317",
      dataDir: h.dataDir,
      spec: codexSpec(),
      workspacePath: "/repo/sub",
    });
    expect(result.kind).toBe("attached");
    expect(createdWorkspace).toBe("/repo/sub");
    if (result.kind === "attached") {
      expect(result.chatId).toBe("fresh-chat");
    }
  });

  it("refuses a vendor with no coordinator seat", async () => {
    const h = harness();
    const spec = resolveInstallableVendor("cursor")!;
    const result = await attachCoordinatorFlow({
      client: fakeClient(),
      io: h.io,
      apiBase: "http://127.0.0.1:4317",
      dataDir: h.dataDir,
      spec,
      workspacePath: "/repo",
    });
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.reason).toContain("does not hold MUON's coordinator seat");
    }
  });

  it("refuses when muon-mcp cannot be resolved, and mints nothing backend-side", async () => {
    const h = harness();
    h.io.isExecutableFile = () => false;
    h.io.which = () => null;
    const originalArgv = process.argv[1];
    process.argv[1] = "/nowhere/muon";
    let attachCalled = false;
    const client = fakeClient({
      attachCoordinator: async (input) => {
        attachCalled = true;
        return fakeClient().attachCoordinator(input);
      },
    });
    try {
      const result = await attachCoordinatorFlow({
        client,
        io: h.io,
        apiBase: "http://127.0.0.1:4317",
        dataDir: h.dataDir,
        spec: codexSpec(),
        workspacePath: "/repo",
      });
      expect(result.kind).toBe("refused");
      expect(attachCalled).toBe(false);
    } finally {
      process.argv[1] = originalArgv;
    }
  });

  it("rolls back the backend job when the vendor config write fails", async () => {
    const h = harness();
    process.argv[1] = "/opt/muon/bin/muon";
    // codex CLI missing → applyVendorCliWrite refuses.
    h.io.which = () => null;
    let detachedJobId: string | null = null;
    let archivedChatId: string | null = null;
    const client = fakeClient({
      detachCoordinator: async (jobId) => {
        detachedJobId = jobId;
        return { detached: true, jobId };
      },
      archiveChat: async (chatId) => {
        archivedChatId = chatId;
        return {};
      },
    });
    const result = await attachCoordinatorFlow({
      client,
      io: h.io,
      apiBase: "http://127.0.0.1:4317",
      dataDir: h.dataDir,
      spec: codexSpec(),
      workspacePath: "/repo",
    });
    expect(result.kind).toBe("refused");
    expect(detachedJobId).toBe("job-1");
    expect(archivedChatId).toBe("chat-1");
    // No capability file left behind after the rollback.
    expect(
      fs.existsSync(attachedCoordinatorCapabilityFilePath("codex", h.dataDir))
    ).toBe(false);
  });

  it("archives a newly created chat when the backend refuses the attach", async () => {
    const h = harness();
    process.argv[1] = "/opt/muon/bin/muon";
    let archivedChatId: string | null = null;
    const result = await attachCoordinatorFlow({
      client: fakeClient({
        attachCoordinator: async () => {
          throw new Error("seat contention");
        },
        archiveChat: async (chatId) => {
          archivedChatId = chatId;
          return {};
        },
      }),
      io: h.io,
      apiBase: "http://127.0.0.1:4317",
      dataDir: h.dataDir,
      spec: codexSpec(),
      workspacePath: "/repo",
    });

    expect(result.kind).toBe("refused");
    expect(archivedChatId).toBe("chat-1");
  });

  it("reports a failed backend rollback with the exact cleanup command", async () => {
    const h = harness();
    process.argv[1] = "/opt/muon/bin/muon";
    h.io.which = () => null;
    const result = await attachCoordinatorFlow({
      client: fakeClient({
        detachCoordinator: async () => {
          throw new Error("brain unreachable");
        },
        archiveChat: async () => {
          throw new Error("chat still has active job");
        },
      }),
      io: h.io,
      apiBase: "http://127.0.0.1:4317",
      dataDir: h.dataDir,
      spec: codexSpec(),
      workspacePath: "/repo",
    });

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.reason).toContain("job-1");
      expect(result.reason).toContain("muon mcp detach codex");
      expect(result.reason).toContain("could not be archived");
    }
  });
});

describe("detachCoordinatorFlow", () => {
  async function attachFirst(h: Harness): Promise<string> {
    const originalArgv = process.argv[1];
    process.argv[1] = "/opt/muon/bin/muon";
    try {
      const result = await attachCoordinatorFlow({
        client: fakeClient(),
        io: h.io,
        apiBase: "http://127.0.0.1:4317",
        dataDir: h.dataDir,
        spec: codexSpec(),
        workspacePath: "/repo",
      });
      if (result.kind !== "attached") {
        throw new Error(`setup attach failed: ${result.reason}`);
      }
      return result.jobId;
    } finally {
      process.argv[1] = originalArgv;
    }
  }

  it("detaches using the local capability file's jobId, removes the file, and reverts the vendor config to base", async () => {
    const h = harness();
    const jobId = await attachFirst(h);
    let detachedJobId: string | null = null;
    const client: DetachCoordinatorApiClient = {
      detachCoordinator: async (id) => {
        detachedJobId = id;
        return { detached: true, jobId: id };
      },
      listDispatchJobs: async () => [],
    };

    const result = await detachCoordinatorFlow({
      client,
      io: h.io,
      dataDir: h.dataDir,
      spec: codexSpec(),
    });

    expect(result.kind).toBe("detached");
    expect(result.jobId).toBe(jobId);
    expect(detachedJobId).toBe(jobId);
    expect(result.capabilityFileRemoved).toBe(true);
    expect(result.vendorConfigReverted).toBe(true);
    expect(
      fs.existsSync(attachedCoordinatorCapabilityFilePath("codex", h.dataDir))
    ).toBe(false);

    const toml = fs.readFileSync(
      path.join(h.home, ".codex", "config.toml"),
      "utf8"
    );
    expect(toml).toContain("[mcp_servers.muon]");
    expect(toml).not.toContain("MUON_MCP_MODE");
    expect(toml).not.toContain("MUON_ATTACHED_CAPABILITY_FILE");
  });

  it("falls back to listDispatchJobs when the local capability file is already gone", async () => {
    const h = harness();
    const jobId = await attachFirst(h);
    fs.rmSync(attachedCoordinatorCapabilityFilePath("codex", h.dataDir), {
      force: true,
    });
    let detachedJobId: string | null = null;
    const client: DetachCoordinatorApiClient = {
      detachCoordinator: async (id) => {
        detachedJobId = id;
        return { detached: true, jobId: id };
      },
      listDispatchJobs: async () => [
        { id: jobId, vendor: "codex", capabilityMode: "attached-coordinator" },
        { id: "other-job", vendor: "claude-code", capabilityMode: null },
      ],
    };

    const result = await detachCoordinatorFlow({
      client,
      io: h.io,
      dataDir: h.dataDir,
      spec: codexSpec(),
    });

    expect(result.jobId).toBe(jobId);
    expect(detachedJobId).toBe(jobId);
    expect(result.kind).toBe("detached");
  });

  it("is idempotent: detaching twice with nothing left anywhere reports not-attached", async () => {
    const h = harness();
    await attachFirst(h);
    const client: DetachCoordinatorApiClient = {
      detachCoordinator: async (id) => ({ detached: true, jobId: id }),
      listDispatchJobs: async () => [],
    };
    await detachCoordinatorFlow({ client, io: h.io, dataDir: h.dataDir, spec: codexSpec() });

    const second = await detachCoordinatorFlow({
      client,
      io: h.io,
      dataDir: h.dataDir,
      spec: codexSpec(),
    });
    expect(second.kind).toBe("not-attached");
    expect(second.jobId).toBeNull();
  });

  it("treats a 409 backend conflict as a note, not a failure, and still cleans up locally", async () => {
    const h = harness();
    await attachFirst(h);
    const client: DetachCoordinatorApiClient = {
      detachCoordinator: async () => {
        throw new MuonApiHttpError(
          409,
          "Conflict",
          "409: The attached coordinator is absent or already terminal."
        );
      },
      listDispatchJobs: async () => [],
    };
    const result = await detachCoordinatorFlow({
      client,
      io: h.io,
      dataDir: h.dataDir,
      spec: codexSpec(),
    });
    expect(result.kind).toBe("detached");
    expect(result.capabilityFileRemoved).toBe(true);
    expect(result.notes.some((note) => note.includes("409"))).toBe(true);
  });

  it("reports partial cleanup on an untyped/network detach failure instead of claiming success", async () => {
    const h = harness();
    await attachFirst(h);
    const client: DetachCoordinatorApiClient = {
      detachCoordinator: async () => {
        throw new Error("brain unreachable");
      },
      listDispatchJobs: async () => [],
    };
    const result = await detachCoordinatorFlow({
      client,
      io: h.io,
      dataDir: h.dataDir,
      spec: codexSpec(),
    });
    expect(result.kind).toBe("partial");
    expect(result.notes.join(" ")).toContain("brain unreachable");
  });

  it("reports partial cleanup when backend discovery itself is unavailable", async () => {
    const h = harness();
    const client: DetachCoordinatorApiClient = {
      detachCoordinator: async (id) => ({ detached: true, jobId: id }),
      listDispatchJobs: async () => {
        throw new Error("brain unavailable");
      },
    };
    const result = await detachCoordinatorFlow({
      client,
      io: h.io,
      dataDir: h.dataDir,
      spec: codexSpec(),
    });
    expect(result.kind).toBe("partial");
    expect(result.notes.join(" ")).toContain("backend state is unknown");
  });

  it("never destroys a sibling MCP server while reverting", async () => {
    const h = harness();
    fs.mkdirSync(path.join(h.home, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(h.home, ".codex", "config.toml"),
      '[mcp_servers.sibling]\ncommand = "/opt/other/bin/sibling"\n'
    );
    await attachFirst(h);
    const client: DetachCoordinatorApiClient = {
      detachCoordinator: async (id) => ({ detached: true, jobId: id }),
      listDispatchJobs: async () => [],
    };
    await detachCoordinatorFlow({ client, io: h.io, dataDir: h.dataDir, spec: codexSpec() });

    const toml = fs.readFileSync(
      path.join(h.home, ".codex", "config.toml"),
      "utf8"
    );
    expect(toml).toContain("[mcp_servers.sibling]");
    expect(toml).toContain('command = "/opt/other/bin/sibling"');
  });
});
