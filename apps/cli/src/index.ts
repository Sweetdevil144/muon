#!/usr/bin/env node

import { Command } from "commander";
import { registerAgentsCommand } from "./commands/agents.js";
import { registerApproveCommands } from "./commands/approve.js";
import { registerQuestionCommands } from "./commands/questions.js";
import { registerGitHubCommands } from "./commands/github.js";
import { registerShutdownCommand } from "./commands/shutdown.js";
import { registerAssignCommand } from "./commands/assign.js";
import { registerBundleCommand } from "./commands/bundle.js";
import { registerChatCommands } from "./commands/chat.js";
import { registerCompatCommands } from "./commands/compat.js";
import { registerCostCommands } from "./commands/cost.js";
import { registerContextCommand } from "./commands/context.js";
import { registerCrewCommands } from "./commands/crew.js";
import { registerCustomAgentCommands } from "./commands/custom-agents.js";
import { registerDispatchCommands } from "./commands/dispatch.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerFleetCommands } from "./commands/fleet.js";
import { registerHandoffCommand } from "./commands/handoff.js";
import { registerHarnessCommands } from "./commands/harness.js";
import { registerLaneCommands } from "./commands/lane.js";
import { registerLoopCommands } from "./commands/loop.js";
import { registerMcpCommands } from "./commands/mcp.js";
import { registerSetupCommands } from "./commands/setup.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerMetricsCommand } from "./commands/metrics.js";
import { registerNativeProxyCommands } from "./commands/native-proxy.js";
import { registerOnboardCommand } from "./commands/onboard.js";
import { registerPlanCommand } from "./commands/plan.js";
import { registerPolicyCommand } from "./commands/policy.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerQuickstartCommand } from "./commands/quickstart.js";
import { registerReportCommand } from "./commands/report.js";
import { registerRoutingCommands } from "./commands/routing.js";
import { registerScheduleCommands } from "./commands/schedule.js";
import { registerRunCommand } from "./commands/run.js";
import { registerRunnerCommands } from "./commands/runner.js";
import { registerSessionCommands } from "./commands/session.js";
import { registerShipCommand } from "./commands/ship.js";
import { registerStreamCommands } from "./commands/stream.js";
import { registerTaskCommands } from "./commands/task.js";
import { registerTrajectoryCommands } from "./commands/trajectory.js";
import { registerVersionCommand } from "./commands/version.js";
import { registerWorkflowCommands } from "./commands/workflow.js";
import { MuonApiClient } from "./lib/api-client.js";
import { resolveApiBase, resolveApiToken } from "./lib/config.js";
import { ensureBrain } from "./lib/ensure-brain.js";
import { readCliVersion } from "./lib/app-version.js";

const program = new Command();
const cliVersion = await readCliVersion(import.meta.url).catch(() => "0.0.0");

program
  .name("muon")
  .description(
    "MUON — run your AI coding agents as one governed crew, with human approval before anything ships"
  )
  .version(cliVersion)
  .option("--api-base <url>", "Override MUON API base URL")
  .option("--api-token <token>", "API bearer token (or MUON_API_TOKEN env)")
  .addHelpText(
    "after",
    "\nDocs: https://docs.getmuon.com — install, quickstart, CLI reference, MCP, governance, troubleshooting"
  );

// Local-first: before any command talks to the brain, make sure one is running.
// With no explicit target configured, this auto-spawns the embedded brain (it
// picks a free loopback port, mints a local token, writes the lockfile) so the
// CLI "just works" with no server to start. An explicit --api-base or
// MUON_API_BASE means the user is pointing at a known brain, leave it alone.
program.hook("preAction", async (_thisCommand, actionCommand) => {
  // `muon mcp …` is exempt, and this is load-bearing rather than an
  // optimisation: `muon mcp status` REPORTS whether a brain is running and which
  // token branch would fire, so auto-spawning one first would make the command
  // change the exact state it exists to diagnose — a user with a dead brain would
  // be told everything is fine. `muon mcp install/uninstall` needs no brain at
  // all: every read it makes is a local file.
  for (let cmd: Command | null = actionCommand; cmd; cmd = cmd.parent) {
    // Version reads only local package, Git, and GitNexus metadata.
    if (cmd.name() === "version") {
      return;
    }
    // `muon custom-agents …` is exempt too: every read/write it makes is a
    // local JSON file (packages/client/src/custom-agents-store.ts), never the
    // brain, so it must keep working with no brain running at all.
    if (cmd.name() === "custom-agents") {
      return;
    }
    // `muon shutdown` is the OFF switch — auto-spawning a brain just to kill
    // it would be absurd, and "no live brain" is one of its honest answers.
    if (cmd.name() === "shutdown") {
      return;
    }
    // `muon setup` is the FIRST command a new user runs, and every read and
    // write it makes is a local file: vendor config plus the enrolment record.
    // It mints nothing and never calls the brain. Booting a backend for it
    // meant the first thing someone saw could be `muon: <note>` on stderr
    // about a brain failure that has nothing to do with setting up.
    if (cmd.name() === "setup") {
      return;
    }
    if (cmd.name() === "mcp") {
      // ADR-0028 Tier C carve-out: `attach`/`detach` are the two `mcp`
      // subcommands that DO need a live brain — attach mints a real dispatch
      // job, detach revokes one. Every other `mcp` subcommand (install,
      // uninstall, status) stays exempt for the reason above this loop.
      if (actionCommand.name() === "attach" || actionCommand.name() === "detach") {
        break;
      }
      return;
    }
  }
  const opts = program.opts<{ apiBase?: string }>();
  const explicitBase =
    opts.apiBase?.trim() ||
    process.env.MUON_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_MUON_API_BASE?.trim();
  if (explicitBase) {
    return;
  }
  const result = await ensureBrain();
  if (!result.live && result.note) {
    process.stderr.write(`muon: ${result.note}\n`);
  }
  // ADR-0040 D3a — a HUMAN typed this command, which is exactly the evidence
  // the unattended horizon needs and cannot get from polling. Best-effort and
  // never awaited into the command's own latency: failing to assert fails
  // CLOSED (the daemon ages), which is the safe direction.
  //
  // Placed AFTER the exemptions above deliberately. The exempt commands run
  // with no brain at all, and a command that reports whether a brain is alive
  // must not be the thing that wakes one up.
  if (result.live) {
    void createClient()
      .noteHumanPresent("cli")
      .catch(() => undefined);
  }
});

const createClient = () => {
  const opts = program.opts<{ apiBase?: string; apiToken?: string }>();
  return new MuonApiClient(
    resolveApiBase(opts.apiBase),
    fetch,
    resolveApiToken(opts.apiToken, opts.apiBase)
  );
};

registerDoctorCommand(program, createClient);
registerVersionCommand(program);
registerAgentsCommand(program, createClient);
registerOnboardCommand(program, createClient);
registerQuickstartCommand(program, createClient);
registerLaneCommands(program, createClient);
registerTaskCommands(program, createClient);
registerAssignCommand(program, createClient);
registerHandoffCommand(program, createClient);
registerApproveCommands(program, createClient);
registerQuestionCommands(program);
registerGitHubCommands(program, createClient);
registerShutdownCommand(program, createClient);
registerRunCommand(program, createClient);
registerReportCommand(program, createClient);
registerBundleCommand(program, createClient);
registerMetricsCommand(program, createClient);
registerNativeProxyCommands(program, createClient);
registerMemoryCommands(program, createClient);
registerContextCommand(program, createClient);
registerPlanCommand(program, createClient);
// P0.4 policy posture: offline dry-run by default; `--workspace` / `receipts`
// read the stored (enforced) profile and live receipts from the brain.
registerPolicyCommand(program, createClient);
// T5: local plan inspection + foreground run; needs no brain for status/run.
registerProjectCommands(program);
registerSessionCommands(program, createClient);
registerShipCommand(program, createClient);
registerHarnessCommands(program, createClient);
registerLoopCommands(program, createClient);
registerWorkflowCommands(program, createClient);
registerFleetCommands(program, createClient);
registerCrewCommands(program, createClient);
registerCustomAgentCommands(program);
registerChatCommands(program, createClient);
registerRunnerCommands(program, createClient);
registerDispatchCommands(program, createClient);
registerRoutingCommands(program, createClient);
registerScheduleCommands(program, createClient);
registerStreamCommands(program, createClient);
registerTrajectoryCommands(program, createClient);
// S1 of docs/design/cc-as-superagent-delivery.md: register MUON's MCP server
// with the user's OWN coding-agent CLI. install/uninstall/status take no brain
// client — every one of their reads is local (vendor config files + the brain
// lockfile), so they must keep working on exactly the broken machine they
// exist to diagnose. `attach`/`detach` (ADR-0028 Tier C) are the exception:
// they DO need `createClient`, gated by the preAction carve-out above.
registerMcpCommands(program, undefined, createClient);
registerSetupCommands(program);
// ADR-0038 D1 slice 1. Goes THROUGH the brain rather than reading the vendor
// configs itself: there is one enumerator (backend/src/lib/compatibility-
// discovery.ts) and one fixed path table behind it, so the CLI, and any surface
// after it, can never end up inspecting a different set of files.
registerCompatCommands(program, createClient);
registerCostCommands(program, createClient);

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : "Command failed"}\n`);
  process.exitCode = 1;
});
