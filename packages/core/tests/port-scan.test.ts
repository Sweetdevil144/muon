import { describe, expect, it, vi } from "vitest";
import {
  associateListeningPorts,
  cwdMatchesWorkspace,
  isLocalhostListenAddress,
  portsForChat,
} from "../src/port-association.js";

describe("associateListeningPorts", () => {
  it("prefers a direct pid owner when present", () => {
    const associated = associateListeningPorts({
      ports: [{ pid: 42, port: 3000, address: "127.0.0.1" }],
      processCwds: { 42: "/tmp/other" },
      workspaces: [{ chatId: "c1", workspacePath: "/repo" }],
      jobs: [],
      pidOwners: {
        42: {
          kind: "terminal",
          workspacePath: "/repo",
          chatId: "c1",
          sessionId: "terminal-chat:c1",
        },
      },
    });
    expect(associated[0]?.owner?.kind).toBe("terminal");
    expect(associated[0]?.owner?.sessionId).toBe("terminal-chat:c1");
  });

  it("associates by job worktree cwd before workspace root", () => {
    const associated = associateListeningPorts({
      ports: [{ pid: 7, port: 5173, address: "127.0.0.1", command: "vite" }],
      processCwds: { 7: "/repo/.muon/worktrees/task-1" },
      workspaces: [{ chatId: "c1", workspacePath: "/repo" }],
      jobs: [
        {
          jobId: "job-1",
          chatId: "c1",
          workspacePath: "/repo/.muon/worktrees/task-1",
        },
      ],
    });
    expect(associated[0]?.owner).toMatchObject({
      kind: "job",
      jobId: "job-1",
      chatId: "c1",
    });
  });

  it("falls back to workspace when cwd matches the chat root", () => {
    const associated = associateListeningPorts({
      ports: [{ pid: 9, port: 8080, address: "127.0.0.1" }],
      processCwds: { 9: "/work/app" },
      workspaces: [{ chatId: "c2", workspacePath: "/work/app" }],
      jobs: [],
    });
    expect(associated[0]?.owner).toMatchObject({
      kind: "workspace",
      chatId: "c2",
    });
  });

  it("leaves owner unset when cwd cannot be resolved", () => {
    const associated = associateListeningPorts({
      ports: [{ pid: 1, port: 4000, address: "127.0.0.1" }],
      processCwds: {},
      workspaces: [{ chatId: "c1", workspacePath: "/repo" }],
      jobs: [],
    });
    expect(associated[0]?.owner).toBeUndefined();
  });
});

describe("cwdMatchesWorkspace", () => {
  it("matches nested paths under the workspace root", () => {
    expect(cwdMatchesWorkspace("/repo/pkg/src", "/repo")).toBe(true);
    expect(cwdMatchesWorkspace("/repo-evil", "/repo")).toBe(false);
  });
});

describe("portsForChat", () => {
  it("returns only ports owned by the chat or its workspace root", () => {
    const ports = [
      {
        pid: 1,
        port: 3000,
        address: "127.0.0.1",
        owner: { kind: "workspace" as const, chatId: "a", workspacePath: "/one" },
      },
      {
        pid: 2,
        port: 3001,
        address: "127.0.0.1",
        owner: { kind: "job" as const, chatId: "b", workspacePath: "/two" },
      },
      {
        pid: 3,
        port: 3002,
        address: "127.0.0.1",
      },
    ];
    expect(portsForChat(ports, "a", "/one")).toHaveLength(1);
    expect(portsForChat(ports, "a", "/one")[0]?.port).toBe(3000);
  });
});

describe("isLocalhostListenAddress", () => {
  it("accepts loopback binds only", () => {
    expect(isLocalhostListenAddress("127.0.0.1")).toBe(true);
    expect(isLocalhostListenAddress("*")).toBe(true);
    expect(isLocalhostListenAddress("0.0.0.0")).toBe(false);
    expect(isLocalhostListenAddress("192.168.1.2")).toBe(false);
  });
});

describe("createPortScanPoller idle backoff", () => {
  it("backs off when the listen table is unchanged", async () => {
    vi.useFakeTimers();
    const { createPortScanPoller, PORT_SCAN_BASE_INTERVAL_MS } = await import(
      "../src/port-scan.js"
    );
    const delays: number[] = [];
    let resolveScan!: () => void;
    const scan = vi.fn(
      () =>
        new Promise<Array<{ pid: number; port: number; address: string }>>(
          (resolve) => {
            resolveScan = () => resolve([{ pid: 1, port: 3000, address: "127.0.0.1" }]);
          }
        )
    );
    const onUpdate = vi.fn();
    const poller = createPortScanPoller({
      scan,
      onUpdate,
      schedule: (delayMs, run) => {
        delays.push(delayMs);
        setTimeout(run, delayMs);
      },
    });
    poller.start();
    resolveScan();
    await vi.runOnlyPendingTimersAsync();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    resolveScan();
    await vi.runOnlyPendingTimersAsync();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(delays[1]).toBeGreaterThan(PORT_SCAN_BASE_INTERVAL_MS);
    poller.stop();
    vi.useRealTimers();
  });
});

describe("parseLsofListenFieldOutput fixtures", () => {
  it("parses injectable lsof -F output with no subprocess", async () => {
    const { parseLsofListenFieldOutput, dedupeListeningPorts } = await import(
      "../src/port-scan.js"
    );
    const fixture = `
p4242
cnode
n127.0.0.1:3000

p5151
cpython3
n*:8080
`.trim();
    expect(parseLsofListenFieldOutput(fixture)).toEqual([
      { pid: 4242, port: 3000, address: "127.0.0.1", command: "node" },
      { pid: 5151, port: 8080, address: "*", command: "python3" },
    ]);
    expect(dedupeListeningPorts([
      { pid: 1, port: 3000, address: "127.0.0.1" },
      { pid: 1, port: 3000, address: "127.0.0.1" },
    ])).toHaveLength(1);
  });
});

describe("parseSsListenOutput fixtures", () => {
  it("parses linux ss listen rows from fixtures", async () => {
    const { parseSsListenOutput } = await import("../src/port-scan.js");
    const fixture =
      'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=9001,fd=21))';
    expect(parseSsListenOutput(fixture)).toEqual([
      { pid: 9001, port: 5173, address: "127.0.0.1", command: "node" },
    ]);
  });
});

describe("lookupProcessCwds fixtures", () => {
  it("uses injectable runner output for cwd lookup", async () => {
    const { lookupProcessCwds, parseLsofCwdOutput } = await import(
      "../src/process-cwd.js"
    );
    expect(parseLsofCwdOutput("n/Users/dev/app\n")).toBe("/Users/dev/app");
    const runner = vi.fn(async (command, args: readonly string[]) => {
      if (command === "readlink") {
        const pid = args[0]?.match(/^\/proc\/(\d+)\/cwd$/)?.[1];
        return pid ? `/worktrees/${pid}\n` : "";
      }
      const pidIndex = args.indexOf("-p");
      const pid = pidIndex >= 0 ? args[pidIndex + 1] : undefined;
      return pid ? `n/worktrees/${pid}\n` : "";
    });
    const cwds = await lookupProcessCwds([11, 22], runner);
    expect(cwds).toEqual({ 11: "/worktrees/11", 22: "/worktrees/22" });
  });
});
