import { describe, expect, it } from "vitest";
import type { AgentRole, LaneCapabilities, LaneEvent } from "@muon/protocol";
import { BaseLaneAdapter } from "../src/base-lane-adapter.js";
import {
  LANE_PTY_COLS,
  LANE_PTY_ROWS,
  runLaneCommand,
  type LanePtyProcess,
  type LanePtySpawn,
} from "../src/lane-runner.js";

type ByteFrame = { stream: "stdout" | "stderr"; data: string };

/**
 * A scriptable fake pty. Emits `script` chunks asynchronously (as node-pty
 * does), records writes/kills, and exits with `exitCode` unless killed first.
 */
function fakePty(script: string[], exitCode = 0) {
  const kills: string[] = [];
  let spawned: {
    file: string;
    args: string[];
    cwd?: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
  } | null = null;
  let exitListener:
    | ((event: { exitCode: number; signal?: number }) => void)
    | undefined;
  let killed = false;
  const spawn: LanePtySpawn = (options) => {
    spawned = options;
    const child: LanePtyProcess = {
      write: () => undefined,
      resize: () => undefined,
      kill: (signal) => {
        kills.push(signal ?? "SIGTERM");
        if (!killed) {
          killed = true;
          queueMicrotask(() => exitListener?.({ exitCode: 130 }));
        }
      },
      onData: (listener) => {
        queueMicrotask(() => {
          for (const chunk of script) {
            if (killed) return;
            listener(chunk);
          }
          if (!killed) {
            queueMicrotask(() => exitListener?.({ exitCode }));
          }
        });
      },
      onExit: (listener) => {
        exitListener = listener;
      },
    };
    return child;
  };
  return {
    spawn,
    kills,
    spawned: () => spawned,
  };
}

/**
 * GAP2 — the NEGATIVE branch of the double-gate. A lane whose stdout is a
 * machine contract (cursor's `--output-format json`, opencode's line protocol)
 * must stay on pipes even when the caller supplies a pty factory: a pty merges
 * stderr into stdout and adds tty framing, which would corrupt the parse and
 * blind `errorOutput`/`onDiagnostic`.
 */
class PipesOnlyAdapter extends BaseLaneAdapter {
  readonly id = "cursor";
  readonly displayName = "Pipes Only";
  readonly provider = "test";
  readonly role = "worker" as const;
  readonly commandCandidates = ["sh"];
  readonly laneCapabilities: LaneCapabilities = {
    canStreamEvents: true,
    canInterrupt: true,
    canBackground: false,
    supportsApprovals: false,
    supportsWorktrees: false,
  };
  readonly supportedRoles: readonly AgentRole[] = [];
  // Deliberately NOT overridden — the base default is false, which is the
  // whole point: a lane opts INTO a pty, never by omission.
  override taskCommand() {
    return {
      command: "sh",
      args: ["-c", "printf 'out\\n'; printf 'err\\n' >&2"],
    };
  }
  protected override assertLaneBinaryAvailable(): void {}
}

class PtyOptInAdapter extends PipesOnlyAdapter {
  override readonly id = "codex";
  override readonly prefersPtyConsole = true;
}

describe("GAP2 — the pty double-gate's negative branch", () => {
  it("keeps a pipes-contract lane on PIPES even when a pty factory is supplied", async () => {
    let ptyUsed = false;
    const spawn: LanePtySpawn = () => {
      ptyUsed = true;
      throw new Error("a pipes-contract lane must never reach the pty factory");
    };

    const result = await new PipesOnlyAdapter().runTask(
      { taskId: "task-pipes", brief: "brief" },
      () => undefined,
      { pty: { spawn } }
    );

    expect(ptyUsed).toBe(false);
    // The proof it really ran on pipes: the two streams stayed SEPARATE, which
    // a pty cannot do.
    expect(result.output).toBe("out\n");
    expect(result.errorOutput).toBe("err\n");
  });

  it("uses the pty for a lane that opted in — same factory, same call", async () => {
    let ptyUsed = false;
    const spawn: LanePtySpawn = () => {
      ptyUsed = true;
      let exitListener:
        | ((event: { exitCode: number; signal?: number }) => void)
        | undefined;
      return {
        write: () => undefined,
        resize: () => undefined,
        kill: () => undefined,
        onData: (listener) => {
          queueMicrotask(() => {
            listener("out\r\n");
            queueMicrotask(() => exitListener?.({ exitCode: 0 }));
          });
        },
        onExit: (listener) => {
          exitListener = listener;
        },
      } satisfies LanePtyProcess;
    };

    const result = await new PtyOptInAdapter().runTask(
      { taskId: "task-pty-optin", brief: "brief" },
      () => undefined,
      { pty: { spawn } }
    );

    expect(ptyUsed).toBe(true);
    // A pty has one stream, so `errorOutput` is honestly empty.
    expect(result.errorOutput).toBe("");
  });

  it("keeps an opted-in lane on pipes when NO factory is supplied", async () => {
    const result = await new PtyOptInAdapter().runTask(
      { taskId: "task-no-factory", brief: "brief" },
      () => undefined,
      {}
    );
    expect(result.output).toBe("out\n");
    expect(result.errorOutput).toBe("err\n");
  });
});

describe("runLaneCommand pty transport", () => {
  it("relays raw console bytes and returns ANSI-recovered plain output", async () => {
    const frames: ByteFrame[] = [];
    const events: LaneEvent[] = [];
    const pty = fakePty([
      "\x1b[1msession id:\x1b[0m 019fa043-e5c2-7731-b2f3-11312f91d2d2\r\n",
      "⠋ working…\r⠙ working…\r",
      "GOAL: pty transport works\r\n",
    ]);

    const result = await runLaneCommand({
      laneId: "codex",
      taskId: "task-pty",
      command: "codex",
      args: ["exec", "brief"],
      cwd: "/tmp/worktree",
      pty: { spawn: pty.spawn },
      onEvent: (event) => events.push(event),
      onBytes: (frame) => frames.push(frame),
    });

    expect(result.exitCode).toBe(0);
    // Raw bytes, verbatim, single merged stream — this is what the live pane
    // renders and what makes it the vendor's REAL console.
    const raw = frames.map((frame) => frame.data).join("");
    expect(raw).toContain("\x1b[1m");
    expect(raw).toContain("⠋ working…\r");
    expect(frames.every((frame) => frame.stream === "stdout")).toBe(true);
    // Recovered plain text for every downstream parser: styling stripped and
    // the spinner overdraw folded away.
    expect(result.output).toContain(
      "session id: 019fa043-e5c2-7731-b2f3-11312f91d2d2"
    );
    expect(result.output).toContain("GOAL: pty transport works");
    expect(result.output).not.toContain("\x1b[");
    expect(result.output).not.toContain("⠋");
    // A pty has no separate stderr, and the result must not claim one.
    expect(result.errorOutput).toBe("");
    // The spawn was geometry-fixed and env-scrubbed through the lane filter.
    expect(pty.spawned()?.cols).toBe(LANE_PTY_COLS);
    expect(pty.spawned()?.rows).toBe(LANE_PTY_ROWS);
    expect(pty.spawned()?.cwd).toBe("/tmp/worktree");
    // Lifecycle events flow exactly like the pipe leg, and the started event
    // states the transport.
    expect(events[0]?.kind).toBe("task.started");
    expect(events[0]?.metadata?.transport).toBe("pty");
    expect(events.at(-1)?.kind).toBe("task.completed");
  });

  it("emits plain-text progress events without spinner redraw spam", async () => {
    const events: LaneEvent[] = [];
    const pty = fakePty([
      "hello\r\n",
      // Pure redraw chunks add no printable text and must add no events.
      "⠋\r",
      "⠙\r",
      "world\r\n",
    ]);
    await runLaneCommand({
      laneId: "codex",
      taskId: "task-progress",
      command: "codex",
      args: [],
      pty: { spawn: pty.spawn },
      onEvent: (event) => events.push(event),
    });
    const progress = events
      .filter((event) => event.kind === "task.progress")
      .map((event) => event.message);
    expect(progress.join("\n")).toContain("hello");
    expect(progress.join("\n")).toContain("world");
    expect(progress.join("\n")).not.toContain("⠋");
  });

  it("terminates the pty on abort with the pipe leg's 130 contract", async () => {
    const controller = new AbortController();
    const kills: string[] = [];
    let exitListener:
      | ((event: { exitCode: number; signal?: number }) => void)
      | undefined;
    const spawn: LanePtySpawn = () => ({
      write: () => undefined,
      resize: () => undefined,
      kill: (signal) => {
        kills.push(signal ?? "SIGTERM");
        queueMicrotask(() => exitListener?.({ exitCode: 1 }));
      },
      onData: () => undefined,
      onExit: (listener) => {
        exitListener = listener;
      },
    });

    const pending = runLaneCommand({
      laneId: "codex",
      taskId: "task-abort",
      command: "codex",
      args: [],
      pty: { spawn },
      signal: controller.signal,
      onEvent: () => undefined,
    });
    controller.abort(new Error("operator interrupt"));
    const result = await pending;
    expect(kills).toContain("SIGTERM");
    expect(result.exitCode).toBe(130);
  });

  it("filters undefined env values out of the pty environment", async () => {
    const pty = fakePty(["ok\r\n"]);
    await runLaneCommand({
      laneId: "codex",
      taskId: "task-env",
      command: "codex",
      args: [],
      env: { MUON_TEST_PTY_ENV: "value" },
      pty: { spawn: pty.spawn },
      onEvent: () => undefined,
    });
    const env = pty.spawned()?.env ?? {};
    expect(env.MUON_TEST_PTY_ENV).toBe("value");
    for (const value of Object.values(env)) {
      expect(typeof value).toBe("string");
    }
  });
});
