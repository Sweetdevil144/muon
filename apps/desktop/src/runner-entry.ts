import { MuonApiClient } from "@muon/client";
import { runRunnerHost } from "@muon/runner";
import { loadRunnerPtySpawn } from "./lib/runner-pty.js";
import { readDesktopRunnerConfig } from "./lib/runner-entry-config.js";
import {
  createParentLossHandler,
  watchRunnerParent,
} from "./lib/runner-parent-guard.js";
import { guardRunnerOutput } from "./lib/runner-output-guard.js";
import { createRunnerLineFormatter } from "./lib/runner-log-line.js";

// Every line the runner writes lands in <dataDir>/logs/runner.log. Stamp it with
// an ISO timestamp plus the job id and vendor it belongs to, so a runner event
// can be correlated with a backend event in brain.log (it could not be before —
// runner.log had no timestamps at all).
const formatRunnerLine = createRunnerLineFormatter();

async function main(): Promise<void> {
  // Keep this installed until process teardown. Parent loss closes Electron's
  // pipe readers; drain/offline writes can emit EPIPE after runRunnerHost has
  // returned, and removing the guard early would kill the runner before the
  // authoritative parent-loss process-group timer can reap descendants.
  guardRunnerOutput(process.stdout, process.stderr);
  const config = readDesktopRunnerConfig();
  const client = new MuonApiClient(config.apiBase, fetch, config.agentToken);
  const stopParentGuard = watchRunnerParent({
    onParentGone: createParentLossHandler(),
  });
  // The REAL vendor terminal for dispatched one-shot jobs. Loaded here because
  // the desktop app owns node-pty; a load failure logs its reason and the
  // runner keeps today's pipe transport (honest downgrade, never a crash).
  const ptySpawn = await loadRunnerPtySpawn((line) =>
    process.stdout.write(`${formatRunnerLine(`[runner] ${line}`)}\n`)
  );
  try {
    await runRunnerHost({
      client,
      host: config.host,
      apiBase: config.apiBase,
      apiToken: config.agentToken,
      leaseToken: config.leaseToken,
      confined: process.env.MUON_SANDBOX_ACTIVE === "1",
      output: (line) => process.stdout.write(`${formatRunnerLine(line)}\n`),
      ...(ptySpawn ? { ptySpawn } : {}),
    });
  } finally {
    stopParentGuard();
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${formatRunnerLine(
      `[runner] fatal: ${
        error instanceof Error ? error.message : String(error)
      }`
    )}\n`
  );
  process.exitCode = 1;
});
