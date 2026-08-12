import { describe, expect, it, vi } from "vitest";
import type { LaneEvent } from "@muon/protocol";

// F1/F5 — the pty leg must normalize INCREMENTALLY (bounded work per chunk)
// and the RECORDED stream must carry post-`\r` corrected lines. The counting
// wrapper below is the whole point of the mock: it measures how many
// characters `normalizePtyOutput` is asked to process across a run, which is
// the quadratic-blowup signal (re-normalizing the whole accumulated buffer per
// chunk) that wall-clock timing cannot assert deterministically.
const normalizeStats = vi.hoisted(() => ({ calls: 0, inputChars: 0 }));

vi.mock("../src/pty-text.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pty-text.js")>();
  return {
    ...actual,
    normalizePtyOutput: (raw: string) => {
      normalizeStats.calls += 1;
      normalizeStats.inputChars += raw.length;
      return actual.normalizePtyOutput(raw);
    },
  };
});

import {
  runLaneCommand,
  type LanePtyProcess,
  type LanePtySpawn,
} from "../src/lane-runner.js";

/** A fake pty that emits `script` then exits 0. */
function scriptedPty(script: string[]): LanePtySpawn {
  return () => {
    let exitListener:
      | ((event: { exitCode: number; signal?: number }) => void)
      | undefined;
    const child: LanePtyProcess = {
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: (listener) => {
        queueMicrotask(() => {
          for (const chunk of script) listener(chunk);
          queueMicrotask(() => exitListener?.({ exitCode: 0 }));
        });
      },
      onExit: (listener) => {
        exitListener = listener;
      },
    };
    return child;
  };
}

async function run(script: string[]) {
  normalizeStats.calls = 0;
  normalizeStats.inputChars = 0;
  const events: LaneEvent[] = [];
  const result = await runLaneCommand({
    laneId: "codex",
    taskId: "task-incremental",
    command: "codex",
    args: [],
    pty: { spawn: scriptedPty(script) },
    onEvent: (event) => events.push(event),
  });
  const progress = events
    .filter((event) => event.kind === "task.progress")
    .map((event) => String(event.message));
  return { result, progress };
}

describe("F1 — pty normalization is incremental, not quadratic", () => {
  it("keeps total normalize input proportional to total output, not to chunks²", async () => {
    // Real node-pty chunks average ~66 bytes. Re-normalizing the whole
    // accumulated buffer per chunk makes total input O(n²/2) — for 1500
    // chunks that is ~74M characters of synchronous work, which pins the
    // runner's event loop and starves the watchdog/heartbeat timers.
    const CHUNKS = 1500;
    const script = Array.from(
      { length: CHUNKS },
      (_, index) => `line ${index} ${"x".repeat(50)}\r\n`
    );
    const totalChars = script.reduce((sum, chunk) => sum + chunk.length, 0);

    const { result } = await run(script);

    expect(result.exitCode).toBe(0);
    // Bounded: every character is normalized a small constant number of times
    // (once for the streaming pass, once more at most for the final result).
    expect(normalizeStats.inputChars).toBeLessThan(totalChars * 4);
    // Sanity: the quadratic shape would be ~n²/2 ≈ 74M here.
    expect(normalizeStats.inputChars).toBeLessThan(1_000_000);
  });

  it("bounds work even when output never contains a newline", async () => {
    // A spinner that only ever writes `\r` must not let the pending buffer
    // grow without limit or be re-scanned from zero on every chunk.
    const script = Array.from({ length: 1500 }, (_, i) => `\rworking ${i}`);
    const totalChars = script.reduce((sum, chunk) => sum + chunk.length, 0);
    const { result } = await run(script);
    expect(result.exitCode).toBe(0);
    expect(normalizeStats.inputChars).toBeLessThan(totalChars * 6);
  });
});

describe("F5 — the recorded stream carries corrected (post-\\r) lines", () => {
  it("records the CORRECTED line, never the overwritten one", async () => {
    // The founder-visible defect: an agent that prints a provisional status and
    // corrects it in place left the WRONG status in the durable audit record.
    const { result, progress } = await run(["STATUS: fail", "\rSTATUS: pass\n"]);

    expect(progress.join("\n")).toContain("STATUS: pass");
    expect(progress.join("\n")).not.toContain("STATUS: fail");
    expect(result.output).toContain("STATUS: pass");
    expect(result.output).not.toContain("STATUS: fail");
  });

  it("does not emit torn fragments of a line still being written", async () => {
    // Each fragment arrives as its own chunk; the record must show one whole
    // line, not three partial ones.
    const { progress } = await run(["GOAL: ", "half a ", "sentence\n"]);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toBe("GOAL: half a sentence");
  });

  it("still recovers a trailing line the vendor never terminated", async () => {
    const { result, progress } = await run(["done\n", "no trailing newline"]);
    expect(result.output).toContain("no trailing newline");
    expect(progress.join("\n")).toContain("no trailing newline");
  });
});
