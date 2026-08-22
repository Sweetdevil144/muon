import path from "node:path";
import {
  installMcpServer,
  muonMcpUnresolvedRefusal,
  readVendorEntry,
  resolveMuonMcpCommand,
  vendorHoldsCoordinatorSeat,
  INSTALLABLE_VENDORS,
  type InstallableVendorSpec,
  type McpVendorIo,
} from "@muon/client/mcp-vendor-config";
import { readEnrolment, writeEnrolment } from "@muon/client/enrolment";
import { attachCoordinatorFlow } from "@muon/client/attached-coordinator-flow";
import { ensureBrainUnlessExplicitBase } from "./ensure-brain.js";
import { booleanEnvFlag, resolveApiBase } from "@muon/client";
import type { MuonApiClient } from "./api-client.js";
import { runLoginCommand } from "../commands/login.js";
import { detectVendors } from "../commands/setup.js";
import {
  chooseVendors,
  confirm,
  defaultPrompter,
  probeSetupPlan,
  readSetupProgress,
  renderPlan,
  writeSetupProgress,
  type SetupPrompter,
} from "./setup-wizard.js";

/**
 * The guided `muon setup` (founder, 2026-08-20). Four steps, each probed
 * before it runs — see `setup-wizard.ts` for why resume derives from reality.
 *
 * QUITTING IS A SUPPORTED PATH, not an error: ctrl-C between steps loses
 * nothing, because each completed step's artifact is already on disk and the
 * next run's probes will find it. The wizard says so up front.
 */
export async function runInteractiveSetup(input: {
  io: McpVendorIo;
  dataDir: string;
  createClient?: (() => MuonApiClient) | undefined;
  /** The global --api-base flag, forwarded so the seat's capability file and
   *  the client agree on WHICH brain (observer installs are scripted-only). */
  apiBaseFlag?: string | undefined;
  /** `--attach`: re-offer the seat step even if a previous run skipped it. */
  offerAttachAgain: boolean;
  prompter?: SetupPrompter;
}): Promise<void> {
  const prompter = input.prompter ?? defaultPrompter();
  const probe = { io: input.io, dataDir: input.dataDir };

  const opening = probeSetupPlan(probe);
  process.stdout.write(
    [
      "MUON setup — guided, and resumable: quit any time (ctrl-C); re-run `muon setup` and completed steps stay done.",
      "",
      renderPlan(opening),
      "",
    ].join("\n")
  );

  // ---- [1/4] GitHub sign-in ----------------------------------------------
  if (opening[0]!.state.kind !== "satisfied") {
    if (!input.createClient) {
      throw new Error(
        "Sign-in needs a connection to the brain, and this build did not wire one. Run `muon login` directly."
      );
    }
    process.stdout.write("\n[1/4] GitHub sign-in\n");
    // `setup` is brain-exempt (the scripted path only writes local files), so
    // the preAction hook did NOT start the brain — but the device flow and the
    // attach step below are brain-backed. Ensure it here, lazily, only on the
    // paths that need it: a fresh machine otherwise died with a connection
    // error where `muon login` would have succeeded.
    await ensureBrainUnlessExplicitBase(input.apiBaseFlag);
    await runLoginCommand(input.createClient, {}, {});
    if (process.exitCode && process.exitCode !== 0) {
      // The login flow already printed WHY and how to recover; the wizard
      // adds only the resume promise.
      process.stdout.write(
        "\nSetup paused at sign-in. Re-run `muon setup` to continue from here — nothing done so far is lost.\n"
      );
      return;
    }
  } else {
    process.stdout.write(`\n[1/4] GitHub sign-in — ${opening[0]!.state.detail}, skipping.\n`);
  }

  // ---- [2/4] Choose agent CLIs -------------------------------------------
  // Re-probed rather than trusted from the opening render: step 1 may have
  // just changed the world.
  const afterLogin = probeSetupPlan(probe);
  let chosen: InstallableVendorSpec[];
  if (afterLogin[1]!.state.kind === "satisfied") {
    process.stdout.write(`\n[2/4] Agent CLIs — ${afterLogin[1]!.state.detail}.\n`);
    const change = await confirm(prompter, "Change the recorded choice?", false);
    chosen = change
      ? await reasking(prompter, () => promptChoice(prompter, input.io))
      : enrolledSpecs(probe.dataDir);
  } else {
    process.stdout.write("\n[2/4] Choose your agent CLIs\n");
    chosen = await reasking(prompter, () => promptChoice(prompter, input.io));
  }
  if (chosen.length === 0) {
    process.stdout.write(
      "No agent CLI chosen — nothing to install into. Re-run `muon setup` when one is on your PATH.\n"
    );
    return;
  }
  // The DECISION is recorded before the installs run (same rule as scripted
  // setup): a vendor whose write fails is still one the human chose. Each
  // vendor keeps the MODE it was already recorded in (the wizard has no
  // --observer path — that is scripted-only); a newly chosen vendor records
  // as base, the durable default.
  const priorRecord = readEnrolment(input.dataDir);
  const recordedModeOf = (id: string): "base" | "observer" =>
    (priorRecord.ok
      ? priorRecord.enrolment.vendors.find((vendor) => vendor.id === id)?.mode
      : undefined) ?? "base";
  writeEnrolment(
    {
      vendors: chosen.map((spec) => ({
        id: spec.id,
        mode: recordedModeOf(spec.id),
      })),
    },
    input.dataDir
  );

  // ---- [3/4] Install ------------------------------------------------------
  process.stdout.write("\n[3/4] Install MUON into them\n");
  const resolution = resolveMuonMcpCommand(input.io);
  if (!resolution.ok) {
    throw new Error(muonMcpUnresolvedRefusal(resolution.searched));
  }
  let failures = 0;
  for (const spec of chosen) {
    const current = readVendorEntry(spec, spec.defaultScope, input.io.roots);
    // NEVER SILENTLY DOWNGRADE A COORDINATOR SEAT — the same guard the
    // scripted path has had since it turned a 44-tool seat into a 30-tool one
    // in silence. The wizard is the TTY default now, so it needs the guard
    // MORE, not less. Changing tiers is `muon mcp detach`, chosen by a human.
    if (
      current.kind === "present" &&
      current.environment?.MUON_MCP_MODE === "attached-coordinator"
    ) {
      process.stdout.write(
        `  · ${spec.id}: holds an attached COORDINATOR seat — leaving it alone (run 'muon mcp detach' first if you want the plain registration).\n`
      );
      continue;
    }
    // Already registered at this scope in ITS recorded mode → nothing to do.
    // Re-installing unconditionally made a bare re-run rewrite every entry.
    const vendorMode = recordedModeOf(spec.id);
    if (
      current.kind === "present" &&
      (vendorMode === "base"
        ? current.environment?.MUON_MCP_MODE === undefined
        : current.environment?.MUON_MCP_MODE === vendorMode)
    ) {
      process.stdout.write(`  ✓ ${spec.id} (already registered)\n`);
      continue;
    }
    const outcome = installMcpServer(input.io, {
      spec,
      scope: spec.defaultScope,
      command: resolution.command,
      dryRun: false,
      ...(vendorMode === "observer" ? { mode: "observer" as const } : {}),
    });
    if (outcome.kind === "refused") {
      failures += 1;
      process.stdout.write(`  ✗ ${spec.id}: ${outcome.reason}\n`);
    } else {
      process.stdout.write(`  ✓ ${spec.id}\n`);
    }
  }
  if (failures > 0) {
    process.stdout.write(
      "\nSetup paused: fix the reasons above and re-run `muon setup` — your choice is recorded, completed installs stay done.\n"
    );
    process.exitCode = 1;
    return;
  }

  // ---- [4/4] Coordinator seat (optional) ---------------------------------
  const beforeAttach = probeSetupPlan(probe);
  const attachState = beforeAttach[3]!.state;
  if (attachState.kind === "satisfied") {
    process.stdout.write(`\n[4/4] Coordinator seat — ${attachState.detail}, skipping.\n`);
  } else if (attachState.kind === "skipped" && !input.offerAttachAgain) {
    process.stdout.write(`\n[4/4] Coordinator seat — ${attachState.detail}.\n`);
  } else if (!input.createClient) {
    process.stdout.write(
      "\n[4/4] Coordinator seat — this build has no brain connection wired; run `muon mcp attach <vendor>` directly.\n"
    );
  } else {
    process.stdout.write(
      [
        "",
        "[4/4] Coordinator seat (optional)",
        "  An attached seat lets ONE of your CLIs act as the crew coordinator —",
        "  dispatch, steer, interrupt, ship — inside a session you start yourself.",
        "  It is session-scoped (a lease, renewed while the session lives).",
      ].join("\n") + "\n"
    );
    const wants = await confirm(prompter, "Attach a coordinator seat now?", false);
    if (!wants) {
      // The ONE journaled fact: a deliberate "no", so re-runs stop asking.
      writeSetupProgress(
        { ...readSetupProgress(input.dataDir), version: 1, attachSkipped: true },
        input.dataDir
      );
      process.stdout.write(
        "  Skipped — re-run `muon setup --attach` (or `muon mcp attach <vendor>`) whenever you want one.\n"
      );
    } else {
      // ONLY the CLIs this run set up: offering a seat to a vendor the user
      // never chose fails deep inside the flow, after a chat may already be
      // minted. (Since ADR-0057 every public vendor holds the seat, so an
      // empty pool means an empty CHOICE, already refused above.)
      const pool = chosen.filter((spec) => vendorHoldsCoordinatorSeat(spec.id));
      if (pool.length === 0) {
        process.stdout.write(
          "  None of your chosen CLIs can hold the coordinator seat — skipping.\n"
        );
        return;
      }
      const vendor = await reasking(prompter, () => chooseOne(prompter, pool));
      await ensureBrainUnlessExplicitBase(input.apiBaseFlag);
      const result = await attachCoordinatorFlow({
        client: input.createClient(),
        io: input.io,
        apiBase: resolveApiBase(input.apiBaseFlag),
        dataDir: input.dataDir,
        spec: vendor,
        workspacePath: path.resolve(process.cwd()),
        // The SAME policy switch `muon mcp attach` honours — one governed act,
        // one answer, whichever surface asks.
        requireGitHubIdentity:
          booleanEnvFlag(process.env.MUON_REQUIRE_GITHUB_LOGIN) === true,
      });
      if (result.kind === "refused") {
        process.stdout.write(
          `  ✗ attach refused: ${result.reason}\n  Everything else is set up; run \`muon mcp attach ${vendor.id}\` once this is fixed.\n`
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`  ✓ attached ${vendor.id} (job ${result.jobId})\n`);
    }
  }

  // ---- recap --------------------------------------------------------------
  process.stdout.write(
    [
      "",
      "Setup complete.",
      renderPlan(probeSetupPlan(probe)),
      "",
      "Restart any agent CLI that is currently running — a live session keeps the server it already spawned.",
      "",
    ].join("\n")
  );
}

function enrolledSpecs(dataDir: string): InstallableVendorSpec[] {
  // Read back what step 2's probe read: the enrolment record. Re-read here
  // rather than passed through, so a mid-wizard change on disk — another
  // terminal running setup — is seen, not overwritten blind.
  const stored = readEnrolment(dataDir);
  if (!stored.ok) return [];
  return stored.enrolment.vendors
    .map((vendor) => INSTALLABLE_VENDORS.find((spec) => spec.id === vendor.id))
    .filter((spec): spec is InstallableVendorSpec => Boolean(spec));
}

async function promptChoice(
  prompter: SetupPrompter,
  io: McpVendorIo
): Promise<InstallableVendorSpec[]> {
  const detected = detectVendors(io);
  if (detected.installed.length === 0) {
    process.stdout.write(
      "  No agent CLI detected on PATH — you can still pick one to pre-register (the config is read when it arrives).\n"
    );
  }
  return chooseVendors(prompter, detected.installed);
}

/**
 * A typo at a prompt re-asks; it does not abort a wizard whose earlier steps
 * all succeeded. Bounded, so a scripted prompter that keeps answering wrong
 * cannot loop forever — the last error propagates.
 */
async function reasking<T>(
  prompter: SetupPrompter,
  attempt: () => Promise<T>,
  tries = 3
): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < tries; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      process.stdout.write(
        `  ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }
  throw lastError;
}

async function chooseOne(
  prompter: SetupPrompter,
  pool: readonly InstallableVendorSpec[]
): Promise<InstallableVendorSpec> {
  if (pool.length === 1) return pool[0]!;
  process.stdout.write(
    pool.map((spec, index) => `  ${index + 1}. ${spec.id}`).join("\n") + "\n"
  );
  const answer = await prompter.ask(
    `Which CLI should hold the seat? [${pool[0]!.id}]: `
  );
  if (answer === "") return pool[0]!;
  const byIndex = /^\d+$/.test(answer) ? pool[Number(answer) - 1] : undefined;
  const byId = pool.find((spec) => spec.id === answer || spec.aliases.includes(answer));
  const spec = byIndex ?? byId;
  if (!spec) {
    throw new Error(
      `'${answer}' is not one of: ${pool.map((candidate) => candidate.id).join(", ")}.`
    );
  }
  return spec;
}
