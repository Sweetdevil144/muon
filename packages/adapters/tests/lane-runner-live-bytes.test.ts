import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LaneEvent } from "@muon/protocol";
import { runLaneCommand } from "../src/lane-runner.js";
import { CodexAdapter } from "../src/codex-adapter.js";
import {
  CODEX_AMBIENT_SUPPRESSION_ARGS,
  codexGuardEnv,
} from "../src/codex-guard.js";

type ByteFrame = { stream: "stdout" | "stderr"; data: string };

describe("runLaneCommand live console bytes (onBytes)", () => {
  it("relays stdout and stderr as separate, untrimmed streams", async () => {
    const frames: ByteFrame[] = [];
    const result = await runLaneCommand({
      laneId: "codex",
      taskId: "task-bytes",
      command: "sh",
      args: ["-c", "printf 'line one\\n\\n'; printf 'warn\\n' >&2"],
      onEvent: () => undefined,
      onBytes: (frame) => frames.push(frame),
    });

    expect(result.exitCode).toBe(0);
    const stdout = frames
      .filter((frame) => frame.stream === "stdout")
      .map((frame) => frame.data)
      .join("");
    const stderr = frames
      .filter((frame) => frame.stream === "stderr")
      .map((frame) => frame.data)
      .join("");
    // The trailing blank line survives here but NOT in the recorded stream —
    // that is the whole point: `task.progress` carries `text.trimEnd()`, so it
    // can never reconstruct what the console looked like.
    expect(stdout).toBe("line one\n\n");
    expect(stderr).toBe("warn\n");
  });

  it("keeps the two streams separable, which a pty would not", async () => {
    // A pty master merges stderr into stdout. `errorOutput`, `onDiagnostic`,
    // and with them the runner's liveness watchdog all depend on the split, so
    // the live view must not be bought by giving it up.
    const frames: ByteFrame[] = [];
    const diagnostics: string[] = [];
    const result = await runLaneCommand({
      laneId: "codex",
      taskId: "task-split",
      command: "sh",
      args: ["-c", "printf 'out\\n'; printf 'err\\n' >&2; exit 0"],
      onEvent: () => undefined,
      onDiagnostic: (chunk) => diagnostics.push(chunk),
      onBytes: (frame) => frames.push(frame),
    });

    expect(result.output).toBe("out\n");
    expect(result.errorOutput).toBe("err\n");
    expect(diagnostics.join("")).toBe("err\n");
    expect(frames.some((frame) => frame.stream === "stderr")).toBe(true);
  });

  it("leaves the run byte-identical when no live sink is attached", async () => {
    const events: LaneEvent[] = [];
    const withSink = await runLaneCommand({
      laneId: "codex",
      taskId: "task-a",
      command: "sh",
      args: ["-c", "printf 'same\\n'; printf 'e\\n' >&2; exit 2"],
      onEvent: (event) => events.push(event),
      onBytes: () => undefined,
    });
    const withoutSink = await runLaneCommand({
      laneId: "codex",
      taskId: "task-a",
      command: "sh",
      args: ["-c", "printf 'same\\n'; printf 'e\\n' >&2; exit 2"],
      onEvent: () => undefined,
    });

    expect(withSink.output).toBe(withoutSink.output);
    expect(withSink.errorOutput).toBe(withoutSink.errorOutput);
    expect(withSink.exitCode).toBe(withoutSink.exitCode);
    expect(events.map((event) => event.kind)).toContain("task.blocked");
  });

  it("a throwing live sink cannot lose the vendor's output or fail the run", async () => {
    const result = await runLaneCommand({
      laneId: "codex",
      taskId: "task-hostile",
      command: "sh",
      args: ["-c", "printf 'still recorded\\n'; printf 'err\\n' >&2"],
      onEvent: () => undefined,
      onBytes: () => {
        throw new Error("a viewer exploded");
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("still recorded\n");
    expect(result.errorOutput).toBe("err\n");
  });
});

describe("the Codex ambient-config guard still applies on the live-terminal path", () => {
  it("keeps the guard home, the guard env, and the suppression args with onBytes attached", async () => {
    const guardHome = mkdtempSync(join(tmpdir(), "muon-codex-guard-test-"));
    const seen: {
      command: string;
      args: string[];
      env: Record<string, string | undefined>;
    }[] = [];
    let prepared = 0;

    class ProbeCodexAdapter extends CodexAdapter {
      // Only the SPAWN is replaced. `runTask` — and with it
      // `prepareCodexGuardHome` + `codexGuardEnv` — runs exactly as in
      // production, which is what makes this a guard assertion rather than a
      // restatement of the test's own setup.
      protected override spawnCompiledRun(
        _input: { taskId: string; brief: string },
        _onEvent: (event: LaneEvent) => void,
        _options: unknown,
        invocation: { command: string; args: string[] },
        compiled: { args: string[]; env?: Record<string, string> }
      ) {
        seen.push({
          command: invocation.command,
          args: [...invocation.args, ...compiled.args],
          env: compiled.env ?? {},
        });
        return Promise.resolve({
          exitCode: 0,
          output: "",
          errorOutput: "",
          durationMs: 0,
        });
      }

      protected override assertLaneBinaryAvailable(): void {
        // The guard, not binary discovery, is what this test is about.
      }
    }

    try {
      const adapter = new ProbeCodexAdapter({
        prepareGuardHome: () => {
          prepared += 1;
          return { home: guardHome, authLinked: false };
        },
      });
      await adapter.runTask(
        { taskId: "task-guard", brief: "do the thing" },
        () => undefined,
        {
          cwd: guardHome,
          // The live sink is present on this run and must change nothing.
          onBytes: () => undefined,
        }
      );

      expect(prepared).toBe(1);
      const run = seen[0]!;
      expect(run.command).toBe("codex");
      // CODEX_HOME still points at MUON's guard directory, not the operator's.
      expect(run.env).toMatchObject(codexGuardEnv(guardHome));
      // The ambient-suppression args still sit between the subcommand and the
      // brief, so a run that carries no profile is still isolated.
      for (const arg of CODEX_AMBIENT_SUPPRESSION_ARGS) {
        expect(run.args).toContain(arg);
      }
      expect(run.args[0]).toBe("exec");
      expect(run.args).toContain("do the thing");
    } finally {
      rmSync(guardHome, { recursive: true, force: true });
    }
  });
});
