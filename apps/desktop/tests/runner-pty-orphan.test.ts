import { describe, expect, it } from "vitest";
import {
  terminateLanePtyChildren,
  liveLanePtyChildCount,
  runLaneCommand,
} from "@muon/adapters";
import { runnerPtySpawnFromModule } from "../src/lib/runner-pty.js";

// F2 — node-pty calls setsid(), so a pty child LEADS ITS OWN process group and
// is invisible to every group-based teardown MUON has (the parent guard's
// kill(-runnerPid), the supervisor's signalProcessGroup). Without an explicit
// registry, an Electron crash or a runner force-kill leaves a
// danger-full-access vendor child alive, still editing the worktree,
// unobserved. These tests use a REAL pty because the escape is a real OS
// behaviour a fake could not reproduce.

const nodePty = require("node-pty") as Parameters<
  typeof runnerPtySpawnFromModule
>[0];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("F2 — pty children never outlive the runner", () => {
  it("the pty child really does escape the runner's process group", () => {
    // The premise, asserted rather than assumed: if this ever stops being
    // true the registry below is belt-and-braces rather than the only rope.
    const spawn = runnerPtySpawnFromModule(nodePty);
    const child = spawn({
      file: "/bin/sh",
      args: ["-c", "sleep 30"],
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "" },
      cols: 80,
      rows: 24,
    });
    const pid = child.pid;
    expect(pid).toBeGreaterThan(0);
    // A child in OUR group would share our pgid.
    expect(pid).not.toBe(process.pid);
    child.kill("SIGKILL");
  });

  it("tracks a live pty child and kills it on runner teardown", async () => {
    const spawn = runnerPtySpawnFromModule(nodePty);
    let childPid = 0;
    const before = liveLanePtyChildCount();

    const run = runLaneCommand({
      laneId: "codex",
      taskId: "task-orphan",
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
      cwd: "/tmp",
      pty: {
        spawn: (options) => {
          const child = spawn(options);
          childPid = child.pid ?? 0;
          return child;
        },
      },
      onEvent: () => undefined,
    });

    await settle(300);
    expect(childPid).toBeGreaterThan(0);
    expect(alive(childPid)).toBe(true);
    expect(liveLanePtyChildCount()).toBe(before + 1);

    // The runner is going down (parent loss / SIGTERM / force-kill).
    terminateLanePtyChildren();
    await run;
    await settle(300);

    expect(alive(childPid)).toBe(false);
    expect(liveLanePtyChildCount()).toBe(before);
  });

  it("kills the child's whole group, so vendor DESCENDANTS die too", async () => {
    // A vendor CLI spawns shells of its own. Killing only the pty leader would
    // leave those grandchildren editing the worktree.
    const spawn = runnerPtySpawnFromModule(nodePty);
    const pidFile = `/tmp/muon-orphan-probe-${process.pid}-${Date.now()}`;
    let childPid = 0;

    const run = runLaneCommand({
      laneId: "codex",
      taskId: "task-orphan-group",
      command: "/bin/sh",
      args: ["-c", `sh -c 'echo $$ > ${pidFile}; sleep 30' & sleep 30`],
      cwd: "/tmp",
      pty: {
        spawn: (options) => {
          const child = spawn(options);
          childPid = child.pid ?? 0;
          return child;
        },
      },
      onEvent: () => undefined,
    });

    await settle(600);
    const { readFileSync, rmSync } = await import("node:fs");
    const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
    rmSync(pidFile, { force: true });
    expect(grandchildPid).toBeGreaterThan(0);
    expect(alive(grandchildPid)).toBe(true);

    terminateLanePtyChildren();
    await run;
    await settle(400);

    expect(alive(childPid)).toBe(false);
    expect(alive(grandchildPid)).toBe(false);
  });

  it("unregisters a child that exited on its own (no leak, no stale kill)", async () => {
    const spawn = runnerPtySpawnFromModule(nodePty);
    const before = liveLanePtyChildCount();
    await runLaneCommand({
      laneId: "codex",
      taskId: "task-clean-exit",
      command: "/bin/echo",
      args: ["done"],
      cwd: "/tmp",
      pty: { spawn },
      onEvent: () => undefined,
    });
    expect(liveLanePtyChildCount()).toBe(before);
  });
});
