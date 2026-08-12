import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/codex-adapter.js";
import { CODEX_AMBIENT_SUPPRESSION_ARGS } from "../src/codex-guard.js";
import { runLaneCommand } from "../src/lane-runner.js";

/**
 * P0-1. A one-shot vendor child must never be left holding an open stdin pipe.
 *
 * `codex exec [PROMPT]` takes the brief on argv but ALSO reads stdin whenever
 * stdin is not a tty, appending it as a `<stdin>` block. Node's default stdio is
 * three pipes and nothing on this path ever writes to or ends the child's stdin,
 * so before the fix every governed Codex worker blocked forever on an EOF that
 * could not arrive: the founder's live terminal showed
 * `Reading additional input from stdin...` and then nothing, and both
 * implementer jobs died to the watchdog having produced zero output.
 *
 * These use `node` rather than `codex` so they assert MUON's side of the
 * contract on any machine, with no vendor install, no login, and no model turn.
 */
describe("runLaneCommand stdin delivery", () => {
  it("gives the child EOF on stdin instead of an open pipe", async () => {
    // Resolves only on stdin 'end'. With the pre-fix open pipe this never fires
    // and the run hangs until `timeoutMs` kills it; with /dev/null it is
    // immediate. The timeout is the failure mode, so it is short and the
    // assertion below distinguishes the two outcomes rather than just "passed".
    const result = await runLaneCommand({
      laneId: "codex",
      taskId: "stdin-eof",
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.on('end', () => console.log('STDIN_EOF')); process.stdin.resume();",
      ],
      timeoutMs: 10_000,
      onEvent: () => undefined,
    });

    expect(result.output).toContain("STDIN_EOF");
    expect(result.exitCode).toBe(0);
  });

  it("reports stdin as not a TTY and readable-to-EOF, never an inherited console", async () => {
    // The other half of the contract: EOF must come from /dev/null, not from a
    // tty the child could block on interactively.
    const result = await runLaneCommand({
      laneId: "codex",
      taskId: "stdin-shape",
      command: process.execPath,
      args: [
        "-e",
        "console.log('isTTY=' + Boolean(process.stdin.isTTY));",
      ],
      timeoutMs: 10_000,
      onEvent: () => undefined,
    });

    expect(result.output).toContain("isTTY=false");
  });

  it("does not hang when the child would read stdin before writing output", async () => {
    // The exact codex shape: announce, then read stdin to completion, then work.
    // Pre-fix this produced the founder's one-line-then-nothing transcript.
    const result = await runLaneCommand({
      laneId: "codex",
      taskId: "stdin-read-first",
      command: process.execPath,
      args: [
        "-e",
        [
          "console.log('Reading additional input from stdin...');",
          "let seen = '';",
          "process.stdin.on('data', (c) => { seen += c; });",
          "process.stdin.on('end', () => console.log('WORK_DONE stdin=' + JSON.stringify(seen)));",
        ].join(""),
      ],
      timeoutMs: 10_000,
      onEvent: () => undefined,
    });

    expect(result.output).toContain("WORK_DONE");
    // MUON sends nothing on stdin: the brief travels on argv.
    expect(result.output).toContain('stdin=""');
    expect(result.exitCode).toBe(0);
  });
});

describe("CodexAdapter brief delivery", () => {
  it("puts the brief on argv as the sole positional, after the guard args", () => {
    const invocation = new CodexAdapter().taskCommand("BRIEF: add a flag");

    expect(invocation.command).toBe("codex");
    expect(invocation.args[0]).toBe("exec");
    // The brief is LAST, so the suppression args cannot consume it and it is
    // never mistaken for a `-c` value.
    expect(invocation.args[invocation.args.length - 1]).toBe(
      "BRIEF: add a flag"
    );
    // Exactly one positional: everything between the subcommand and the brief
    // belongs to the ambient-config guard.
    expect(invocation.args.slice(1, -1)).toEqual([
      ...CODEX_AMBIENT_SUPPRESSION_ARGS,
    ]);
  });

  it("never routes the brief through stdin (no `-` prompt placeholder)", () => {
    // `codex exec -` means "read the prompt from stdin". MUON must not emit it:
    // nothing in the runner writes to the child's stdin, so a `-` here would
    // reintroduce the hang by a different route.
    const invocation = new CodexAdapter().taskCommand("BRIEF: do the thing");

    expect(invocation.args).not.toContain("-");
  });
});
