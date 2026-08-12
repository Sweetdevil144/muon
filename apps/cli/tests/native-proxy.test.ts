import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerNativeProxyCommands,
  runNativeVendorProxy,
} from "../src/commands/native-proxy.js";

const workspaces: string[] = [];

async function workspace() {
  const path = await mkdtemp(join(tmpdir(), "muon-native-"));
  workspaces.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("native vendor proxy", () => {
  it("preserves the vendor argv and records a human-owned audited task", async () => {
    const root = await workspace();
    const child = new EventEmitter();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    });
    const client = {
      listDispatchJobs: vi.fn().mockResolvedValue([]),
      createTask: vi.fn().mockResolvedValue({ id: "task-native" }),
      updateTaskStatus: vi.fn().mockResolvedValue({}),
      recordEvent: vi.fn().mockResolvedValue({}),
    };
    const changedFiles = vi
      .fn()
      .mockResolvedValueOnce(["preexisting.ts"])
      .mockResolvedValueOnce(["preexisting.ts", "src/new.ts"]);

    const exitCode = await runNativeVendorProxy(
      {
        vendor: "claude-code",
        args: ["/permissions", "--verbose"],
        workspacePath: root,
      },
      client as never,
      {
        spawn,
        resolveCommand: vi.fn().mockReturnValue("claude"),
        changedFiles,
      }
    );

    expect(exitCode).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      "claude",
      ["/permissions", "--verbose"],
      expect.objectContaining({
        cwd: await realpath(root),
        stdio: "inherit",
        shell: false,
        env: expect.objectContaining({
          MUON_NATIVE_TAKEOVER: "1",
          MUON_TASK_ID: "task-native",
        }),
      })
    );
    expect(client.recordEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        laneId: "native:claude-code",
        taskId: "task-native",
        kind: "task.started",
        metadata: expect.objectContaining({
          authority: "human-owned-native",
          structuredAutomation: false,
        }),
      })
    );
    expect(client.recordEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "task.completed",
        metadata: expect.objectContaining({
          changedFiles: ["preexisting.ts", "src/new.ts"],
          newlyChangedFiles: ["src/new.ts"],
          rawTerminalCaptured: false,
        }),
      })
    );
    // P6: a successful native session settles to "review" (ungated), never "done"
    // (which is gated behind ship-review a native session can't file).
    expect(client.updateTaskStatus).toHaveBeenCalledWith("task-native", "review");
    // …and NEVER left stranded in_progress.
    expect(client.updateTaskStatus).not.toHaveBeenCalledWith(
      "task-native",
      "done"
    );
  });

  it("P6: a successful native session settles to REVIEW (ungated) — the row + ledger never disagree, the task is never stranded in_progress", async () => {
    const root = await workspace();
    const child = new EventEmitter();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    });
    const statuses: string[] = [];
    const client = {
      listDispatchJobs: vi.fn().mockResolvedValue([]),
      createTask: vi.fn().mockResolvedValue({ id: "task-native" }),
      // "review" is UNGATED (only "done" is behind ship-review), so a native
      // session no longer 409s and strands. Record what statuses were written.
      updateTaskStatus: vi.fn((_id: string, status: string) => {
        statuses.push(status);
        return Promise.resolve({});
      }),
      recordEvent: vi.fn().mockResolvedValue({}),
    };
    const changedFiles = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["src/edited.ts"]);

    const exitCode = await runNativeVendorProxy(
      { vendor: "claude-code", args: ["/permissions"], workspacePath: root },
      client as never,
      {
        spawn,
        resolveCommand: vi.fn().mockReturnValue("claude"),
        changedFiles,
      }
    );

    expect(exitCode).toBe(0);
    // Row settles: in_progress → review; never "done" (ungated path), never
    // stranded in_progress.
    expect(statuses).toEqual(["in_progress", "review"]);
    expect(statuses).not.toContain("done");
    // The ledger event agrees the SESSION completed (with the review handoff).
    expect(client.recordEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "task.completed",
        message: expect.stringContaining("in review"),
      })
    );
  });

  it("refuses concurrent native takeover in a workspace with managed work", async () => {
    const root = await workspace();
    const client = {
      listDispatchJobs: vi.fn().mockResolvedValue([
        {
          id: "job-active",
          status: "running",
          workspacePath: root,
        },
      ]),
    };
    const spawn = vi.fn();

    await expect(
      runNativeVendorProxy(
        {
          vendor: "codex",
          args: [],
          workspacePath: root,
        },
        client as never,
        {
          spawn,
          resolveCommand: vi.fn().mockReturnValue("codex"),
          changedFiles: vi.fn().mockResolvedValue([]),
        }
      )
    ).rejects.toThrow(
      "A MUON-managed dispatch is active in this workspace"
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails clearly when the native CLI is not installed", async () => {
    const root = await workspace();
    const client = {
      listDispatchJobs: vi.fn().mockResolvedValue([]),
    };

    await expect(
      runNativeVendorProxy(
        {
          vendor: "cursor",
          args: [],
          workspacePath: root,
        },
        client as never,
        {
          spawn: vi.fn(),
          resolveCommand: vi.fn().mockReturnValue(undefined),
          changedFiles: vi.fn().mockResolvedValue([]),
        }
      )
    ).rejects.toThrow("Cursor native CLI is not installed");
  });

  it("passes unknown native flags through the top-level vendor alias", async () => {
    const child = new EventEmitter();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    });
    const client = {
      listDispatchJobs: vi.fn().mockResolvedValue([]),
      createTask: vi.fn().mockResolvedValue({ id: "task-native" }),
      updateTaskStatus: vi.fn().mockResolvedValue({}),
      recordEvent: vi.fn().mockResolvedValue({}),
    };
    const program = new Command();
    program.exitOverride();
    registerNativeProxyCommands(program, () => client as never, {
      spawn,
      resolveCommand: vi.fn().mockReturnValue("claude"),
      changedFiles: vi.fn().mockResolvedValue([]),
    });

    await program.parseAsync([
      "node",
      "muon",
      "claude",
      "--dangerously-skip-permissions",
      "/permissions",
    ]);

    expect(spawn).toHaveBeenCalledWith(
      "claude",
      ["--dangerously-skip-permissions", "/permissions"],
      expect.objectContaining({ stdio: "inherit", shell: false })
    );
    process.exitCode = undefined;
  });
});
