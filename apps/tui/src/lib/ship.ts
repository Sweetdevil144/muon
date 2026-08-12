import { spawn } from "node:child_process";
import { parseCheckCommand } from "@muon/core";
import type { Lane, MuonApiClient } from "@muon/client";

export type ShipOutcome = {
  ok: boolean;
  message: string;
};

// P3-B (audit M3): the ship check spawns with NO host shell, the command is
// tokenized into a bare argv (`parseCheckCommand`, which refuses shell
// operators) and run directly, so a metacharacter in the string is never
// evaluated by /bin/sh. A command that needs a shell is refused (exitCode 1).
function runCheck(
  command: string,
  cwd: string
): Promise<{ exitCode: number; durationMs: number; refusal?: string }> {
  const startedAt = Date.now();
  let argv: string[];
  try {
    argv = parseCheckCommand(command);
  } catch (error) {
    return Promise.resolve({
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      refusal: error instanceof Error ? error.message : String(error),
    });
  }
  const [file, ...args] = argv;
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd });
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", () => undefined);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, durationMs: Date.now() - startedAt });
    });
    child.on("error", () => {
      resolve({ exitCode: 1, durationMs: Date.now() - startedAt });
    });
  });
}

/**
 * TUI ship review, mirrors `muon ship`: run the check, record the outcome
 * event, file the merge approval (which the backend requires before `done`).
 */
export async function runShipReview(input: {
  client: MuonApiClient;
  lane: Lane;
  taskId: string;
  checkCommand: string;
  cwd?: string;
}): Promise<ShipOutcome> {
  const { client, lane, taskId } = input;
  const cwd = input.cwd ?? process.cwd();

  const result = await runCheck(input.checkCommand, cwd);
  const passed = result.exitCode === 0;
  const summary = `${passed ? "PASS" : "FAIL"} ${input.checkCommand} (${result.durationMs}ms)${
    result.refusal ? `, ${result.refusal}` : ""
  }`;

  await client
    .recordEvent({
      laneId: lane.id,
      taskId,
      kind: passed ? "task.completed" : "task.blocked",
      message: `ship review: ${summary}`,
      metadata: { shipReview: true },
    })
    .catch(() => undefined);

  if (!passed) {
    return { ok: false, message: `ship checks failed: ${summary}` };
  }

  const approval = await client.requestApproval({
    taskId,
    requestedBy: lane.key,
    kind: "merge",
    reason: `ship review passed: ${summary}`.slice(0, 300),
  });

  return {
    ok: true,
    message: `ship passed, merge approval ${approval.id} filed (a/r in inbox)`,
  };
}
