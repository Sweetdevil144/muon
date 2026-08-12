import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import type { MuonApiClient } from "../lib/api-client.js";
import { printJson } from "../lib/output.js";

/**
 * P0-2 — the GitHub identity flow from the terminal. The SAME operator-tier
 * brain routes the Desktop uses (`/api/github/*`): start the device flow,
 * print the one-time code, poll until GitHub answers.
 *
 * Custody is deliberately asymmetric: a successful login connects the LIVE
 * brain (the service holds the credential for its lifetime), but only the
 * Desktop persists it across brain restarts (its 0600 settings file). The
 * output says so — a CLI-only login that silently evaporated on the next
 * reboot would read as a MUON bug. No token is ever printed here.
 */
export function registerGitHubCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const github = program
    .command("github")
    .description(
      "Verify your GitHub identity (device flow) — the same connection Desktop's Settings manages"
    );

  github
    .command("status")
    .option("--json", "Print as JSON")
    .description("Whether a GitHub identity is connected to the live brain")
    .action(async (options: { json?: boolean }) => {
      try {
        const status = await createClient().getGitHubStatus();
        if (options.json) {
          printJson({ github: status });
          return;
        }
        if (!status.configured) {
          process.stdout.write(
            "not configured — set MUON_GITHUB_CLIENT_ID on the brain to enable device authorization\n"
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write(
          status.connected
            ? `connected${status.login ? ` as ${status.login}` : ""}${
                status.expiresAt ? ` (token expires ${status.expiresAt})` : ""
              }\n`
            : "not connected — run `muon github login`\n"
        );
        if (!status.connected) process.exitCode = 1;
      } catch (error) {
        failCommand(error, "GitHub status failed.");
      }
    });

  github
    .command("login")
    .description(
      "Connect GitHub via the device flow: prints a one-time code, waits for you to authorize on github.com"
    )
    .option("--json", "Print the final status as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const client = createClient();
        const flow = await client.startGitHubDeviceFlow();
        process.stderr.write(
          `Open ${flow.verificationUri} and enter this code:\n\n    ${flow.userCode}\n\n` +
            `Waiting for authorization (code expires ${flow.expiresAt})…\n`
        );
        const deadline = Date.parse(flow.expiresAt);
        let waitMs = flow.intervalMs;
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          if (Number.isFinite(deadline) && Date.now() > deadline) {
            process.stdout.write(
              "The GitHub code expired before authorization completed. Run `muon github login` again.\n"
            );
            process.exitCode = 1;
            return;
          }
          // A transient failure reaching the BRAIN (restart, network blip on
          // loopback) must not abandon a device flow GitHub still considers
          // live — retry until the code's own expiry bounds the loop.
          let result;
          try {
            result = await client.pollGitHubDeviceFlow(flow.flowId);
          } catch (error) {
            process.stderr.write(
              `poll failed (${
                error instanceof Error ? error.message : String(error)
              }); retrying…\n`
            );
            continue;
          }
          if (result.status === "pending") {
            waitMs = result.retryAfterMs;
            continue;
          }
          if (result.status === "connected") {
            const line = `connected${result.login ? ` as ${result.login}` : ""}`;
            if (options.json) {
              printJson({
                github: {
                  connected: true,
                  ...(result.login ? { login: result.login } : {}),
                  ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
                },
              });
            } else {
              process.stdout.write(`${line}\n`);
            }
            process.stderr.write(
              "Note: this connects the LIVE brain. The Desktop app is the durable custodian — " +
                "sign in there once to keep the identity across brain restarts.\n"
            );
            return;
          }
          // expired / denied / error all carry a human message.
          process.stdout.write(`${result.message}\n`);
          process.exitCode = 1;
          return;
        }
      } catch (error) {
        failCommand(error, "GitHub login failed.");
      }
    });

  github
    .command("logout")
    .description("Disconnect the live brain's GitHub identity")
    .action(async () => {
      try {
        const status = await createClient().disconnectGitHub();
        process.stdout.write(
          status.connected ? "still connected (unexpected)\n" : "disconnected\n"
        );
        process.stderr.write(
          "If the Desktop app has a persisted credential, disconnect there too (Settings → GitHub), or it will reconnect on its next start.\n"
        );
      } catch (error) {
        failCommand(error, "GitHub logout failed.");
      }
    });
}
