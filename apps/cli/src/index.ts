#!/usr/bin/env node

import { writeSync } from "node:fs";
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
import { registerDocsCommands } from "./commands/docs.js";
import { registerGraphCommands } from "./commands/graph.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerFleetCommands } from "./commands/fleet.js";
import { registerHandoffCommand } from "./commands/handoff.js";
import { registerWrapCommand } from "./commands/wrap.js";
import { registerHarnessCommands } from "./commands/harness.js";
import { registerLaneCommands } from "./commands/lane.js";
import { registerLoginCommands } from "./commands/login.js";
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
import { registerUninstallCommand } from "./commands/uninstall.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerVersionCommand } from "./commands/version.js";
import { registerWorkflowCommands } from "./commands/workflow.js";
import { MuonApiClient } from "./lib/api-client.js";
import { resolveApiBase, resolveApiToken } from "./lib/config.js";
import { ensureBrain, ensureBrainUnlessExplicitBase } from "./lib/ensure-brain.js";
import { readCliVersion } from "./lib/app-version.js";
import { githubIdentityGateDoorMissingWarning } from "@muon/client/github-identity-gate";
import { commandNeedsBrain } from "./lib/brain-exempt.js";
import {
  checkCliIdentityGate,
  isCliDiagnosticCommand,
  resolveCliIdentityGate,
} from "./lib/identity-gate.js";
import {
  cliGateObservatoryEvent,
  recordCliGateEvent,
} from "./lib/observatory.js";

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
  // ADR-0052 — the identity gate, checked BEFORE anything else this hook does.
  //
  // Placed first on purpose: a locked CLI must not spawn a brain, mint a
  // token, or assert human presence on its way to refusing. In a dev checkout
  // `required` is false (there is no distributed bake), so this is a memoized
  // boolean read and the rest of the hook is byte-identical to before.
  const gate = resolveCliIdentityGate();
  if (gate.misconfigured && isCliDiagnosticCommand(actionCommand)) {
    // DIAGNOSTIC SURFACES ONLY, and the asymmetry with `doorMissing` below is
    // the point: this half is a defect in the ARTIFACT, which the person
    // typing the command did not build and cannot fix. Until the install
    // registry is deployed, every published tarball is legitimately baked
    // without a client id, so printing this on every invocation would tell
    // every user, on every command, about a condition that is currently the
    // expected release posture — the "warn about everything" pattern that
    // trains people to read nothing. The publisher already learns it at build
    // time (`bundle-release.mjs` warns), and the surfaces a user consults when
    // asking "is this install healthy" still say it out loud.
    process.stderr.write(
      "muon: RELEASE DEFECT — this distributed build has no GitHub client id, so the identity gate cannot arm and is DISABLED for this run.\n"
    );
  }
  if (gate.doorMissing) {
    // The other half of the same defect, in the opposite direction: the gate is
    // ON by explicit flag and has no door. Said once, in the same voice, so the
    // dead end names the missing piece instead of being discovered.
    process.stderr.write(`${githubIdentityGateDoorMissingWarning("cli")}\n`);
  }
  const verdict = checkCliIdentityGate(actionCommand, gate);
  // ADR-0095 — at most one gate event per run, consent-gated inside. The
  // refusal path awaits its bounded flush (the process exits next line); the
  // pass path must not add telemetry latency to a working command.
  const gateEvent = cliGateObservatoryEvent(gate, verdict);
  if (!verdict.allowed) {
    // writeSync, not write: to a PIPE (`muon … 2>&1 | tee`, any CI capture)
    // stderr is asynchronous on macOS and Linux, so `process.exit` on the very
    // next line can terminate before the buffer drains — dropping the gate's
    // single explanatory message and leaving only exit code 12. The one output
    // a locked install absolutely must deliver is the one telling the person
    // how to unlock it, so it is written synchronously to fd 2 — and BEFORE
    // the telemetry flush below, so the person is never staring at a blank
    // terminal while a telemetry endpoint is dialled.
    writeSync(2, `${verdict.refusal}\n`);
    if (gateEvent) {
      // The one path allowed to attempt egress: `process.exit` on the next
      // line severs any socket this opened, so it cannot outlive the command.
      await recordCliGateEvent(gateEvent, {
        appVersion: cliVersion,
        flushBeforeExit: true,
      });
    }
    process.exit(verdict.exitCode);
  }
  if (gateEvent) {
    // SPOOL-ONLY on the pass path — no egress, no socket, no latency. The
    // spool is the record (ADR-0095 D5); a working command pays nothing.
    void recordCliGateEvent(gateEvent, { appVersion: cliVersion });
  }

  // The whole "does this command need a brain" decision, in one tested place
  // (`lib/brain-exempt.ts`), which is also where the reasoning per command
  // lives. It used to be an inline loop here — the one shape that cannot be
  // unit-tested, because this hook ends in a spawn and a process.exit.
  if (!commandNeedsBrain(actionCommand)) {
    return;
  }
  const opts = program.opts<{ apiBase?: string }>();
  // One policy, shared with the guided setup wizard (which is brain-exempt
  // and makes this call itself before its brain-backed steps).
  const result = await ensureBrainUnlessExplicitBase(opts.apiBase);
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
// ADR-0052: the gate's door. Registered beside version/update because those
// three are what a LOCKED install can still reach.
registerLoginCommands(program, createClient);
registerUpdateCommand(program);
registerUninstallCommand(program);
registerAgentsCommand(program, createClient);
registerOnboardCommand(program, createClient);
registerQuickstartCommand(program, createClient);
registerLaneCommands(program, createClient);
registerTaskCommands(program, createClient);
registerAssignCommand(program, createClient);
registerHandoffCommand(program, createClient);
registerWrapCommand(program, createClient);
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
// ADR-0053: the repository's own markdown as a graph. In-process and client-free
// — the corpus is the working tree, so this answers with no brain running.
registerDocsCommands(program);
// ADR-0054: the local CODE graph's freshness + the reindex gesture the desktop
// had and no headless surface did. Client-free for the same reason as `docs`:
// the store is a directory in the working tree.
registerGraphCommands(program);
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
registerSetupCommands(program, undefined, createClient);
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
