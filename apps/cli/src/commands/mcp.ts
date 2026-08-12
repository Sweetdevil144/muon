import path from "node:path";
import { failCommand } from "../lib/refusal.js";
import type { Command } from "commander";
import {
  MUON_CONTEXT_TOOL_NAMES,
  MUON_COORDINATION_TOOL_NAMES,
  MUON_OBSERVER_TOOL_NAMES,
  coordinatorVendorIds,
  vendorLabel,
} from "@muon/protocol";
// The evaluator and the vendor table are SHARED (`@muon/client`), not local:
// §5 owes the same status read to the TUI palette and the desktop Connections
// row, and neither may import an app package. This command is one of three
// renderers over the ONE `McpStatusReport`.
import {
  INSTALLABLE_VENDORS,
  MCP_CONFIG_SCOPES,
  MUON_MCP_ENTRY_NAME,
  defaultVendorIo,
  installMcpServer,
  installableVendorTokens,
  muonMcpUnresolvedRefusal,
  resolveInstallableVendor,
  resolveMuonMcpCommand,
  uninstallMcpServer,
  vendorHoldsCoordinatorSeat,
  type InstallableVendorSpec,
  type McpConfigScope,
  type McpVendorIo,
} from "@muon/client/mcp-vendor-config";
import { assessMcpDrift } from "@muon/client/mcp-drift";
import {
  compareLiveTools,
  probeVerdictIsProblem,
  type McpProbeVerdict,
} from "@muon/client/mcp-probe";
import { probeMcpToolNames } from "@muon/client/mcp-probe-spawn";
import {
  buildMcpStatusReport,
  type McpStatusReport,
  type McpVendorStatus,
} from "@muon/client/mcp-status";
// ADR-0028 Tier C: the SAME attach/detach evaluator the desktop Connections
// row and the TUI's mcp-attach/mcp-detach actions call. `attach`/`detach` are
// the only two `mcp` subcommands that need a live brain — everything else in
// this file stays offline-diagnosable on purpose (see the preAction hook in
// ../index.ts, which exempts `mcp` from the auto-spawn EXCEPT these two).
import {
  attachCoordinatorFlow,
  detachCoordinatorFlow,
  type AttachCoordinatorFlowResult,
  type DetachCoordinatorFlowResult,
} from "@muon/client/attached-coordinator-flow";
import { booleanEnvFlag, resolveApiBase } from "@muon/client";
import { resolveDataDir } from "@muon/client/paths";
import type { MuonApiClient } from "../lib/api-client.js";
import { ensureRunner } from "../lib/ensure-runner.js";
import { printError, printJson } from "../lib/output.js";

/**
 * `muon mcp install | status | uninstall` — S1 of
 * docs/design/cc-as-superagent-delivery.md §2.2.
 *
 * The product claim: a human runs plain `claude` (or `codex`, or `cursor-agent`,
 * or `opencode`) in their own terminal and that session gets MUON's shared brain
 * — a human-confirmed memory graph fused with a code graph — at AGENT tier, with
 * no token to paste and no base URL to configure. One command makes that true.
 *
 * Discoverability is treated as a feature here, not a doc (§3): `install` prints
 * the file it wrote, the exact entry, the tier that entry gets, the tool count,
 * and the single next action. `status` re-verifies the recorded command path on
 * every run and names EVERY reason the answer could be wrong (§3.2).
 *
 * What this command deliberately does NOT do: custody any credential. It writes
 * no MUON token (§1.4a — the brain re-mints it every boot), no `MUON_API_BASE`
 * (§1.4b — an explicit base switches off the lockfile resolver this depends on),
 * and no `MUON_MCP_MODE` (so "installed" can never be mistaken for
 * "privileged"). It never runs a vendor `login`: that is a human action.
 */

const BASE_TOOL_COUNT =
  MUON_CONTEXT_TOOL_NAMES.length + MUON_COORDINATION_TOOL_NAMES.length;
const OBSERVER_TOOL_COUNT = new Set([
  ...MUON_CONTEXT_TOOL_NAMES,
  ...MUON_COORDINATION_TOOL_NAMES,
  ...MUON_OBSERVER_TOOL_NAMES,
]).size;

/** Injected so tests drive install/status against a temp HOME. */
export type McpCommandDeps = {
  io: McpVendorIo;
  env: Readonly<Record<string, string | undefined>>;
};

function realDeps(): McpCommandDeps {
  return { io: defaultVendorIo(), env: process.env };
}

function parseScope(raw: string | undefined): McpConfigScope | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const cleaned = raw.trim().toLowerCase();
  if ((MCP_CONFIG_SCOPES as readonly string[]).includes(cleaned)) {
    return cleaned as McpConfigScope;
  }
  // `local` is named explicitly in the error because it is the vendor default
  // MUON refuses to write: a local-scope entry lives under `projects.<cwd>` and
  // is invisible from every other repository.
  throw new Error(
    cleaned === "local"
      ? "MUON does not install at 'local' scope: a local-scope entry is per-directory, so the tools would be missing in every other repo. Use --scope user (default) or --scope project."
      : `Unknown scope '${raw}'. Expected one of: ${MCP_CONFIG_SCOPES.join(", ")}.`
  );
}

function parseInstallMode(raw: string | undefined): "observer" | undefined {
  const cleaned = raw?.trim().toLowerCase();
  if (!cleaned || cleaned === "base") return undefined;
  if (cleaned === "observer") return "observer";
  throw new Error(
    `Unknown install mode '${raw}'. Expected base or observer; authority-bearing modes cannot be installed into a human-launched session.`
  );
}

function parseChatId(raw: string | undefined): string | undefined {
  const chatId = raw?.trim();
  if (!chatId) return undefined;
  if (chatId.length > 128) throw new Error("--chat exceeds 128 characters.");
  return chatId;
}

function requireVendor(token: string): InstallableVendorSpec {
  const spec = resolveInstallableVendor(token);
  if (!spec) {
    throw new Error(
      `Unknown vendor '${token}'. MUON can install its MCP server into: ${installableVendorTokens()}.`
    );
  }
  return spec;
}

/** The two separate booleans, always printed together (§2.2). */
function seatLine(spec: InstallableVendorSpec): string {
  return vendorHoldsCoordinatorSeat(spec.id)
    ? "holds the coordinator seat (it can be the superagent that dispatches a crew)"
    : "holds NO coordinator seat — it can use MUON's brain but can never coordinate a crew. 'installable' and 'can coordinate' are two separate booleans.";
}

export function registerMcpCommands(
  program: Command,
  deps?: McpCommandDeps,
  // ADR-0028 Tier C only. Undefined in the one call site that still exists
  // for offline diagnosis alone (there is none today — apps/cli/src/index.ts
  // always wires one — but `attach`/`detach` refuse cleanly rather than throw
  // a TypeError if a future caller omits it).
  createClient?: () => MuonApiClient
) {
  const resolveDeps = () => deps ?? realDeps();

  const mcp = program
    .command("mcp")
    .description(
      "Register MUON's MCP server with your own coding-agent CLI, so a session you start yourself gets MUON's memory + code graph"
    );

  mcp
    .command("install")
    .argument("<vendor>", `which CLI to register with (${installableVendorTokens()})`)
    .description(
      "Write the muon-mcp server entry into a vendor's own MCP config (no token or API base; base or read-only observer mode; idempotent)"
    )
    .option(
      "--scope <scope>",
      `${MCP_CONFIG_SCOPES.join("|")} (default: user, so the tools follow you across repos)`
    )
    .option("--dry-run", "print exactly what would be written, and write nothing")
    .option(
      "--mode <mode>",
      "base|observer (observer adds bounded read-only crew status; never control authority)"
    )
    .option(
      "--chat <id>",
      "partition memory and observer reads to this durable mission chat"
    )
    .option("--json", "print the outcome as JSON")
    .action(
      async (
        vendorToken: string,
        options: {
          scope?: string;
          dryRun?: boolean;
          mode?: string;
          chat?: string;
          json?: boolean;
        }
      ) => {
        try {
          const { io } = resolveDeps();
          const spec = requireVendor(vendorToken);
          const scope = parseScope(options.scope) ?? spec.defaultScope;
          const mode = parseInstallMode(options.mode);
          const chatId = parseChatId(options.chat);

          // D-cmd: resolve NOW, verify, and record. A bare `muon-mcp` is broken
          // for a .dmg-only user and MUON has no interpose inside the user's own
          // CLI, so an unverifiable command is a refusal, not a guess.
          const resolution = resolveMuonMcpCommand(io);
          if (!resolution.ok) {
            // The message is SHARED, not written here: the desktop's Connections
            // row refuses the same .dmg-only case and must say the same words.
            throw new Error(muonMcpUnresolvedRefusal(resolution.searched));
          }

          const outcome = installMcpServer(io, {
            spec,
            scope,
            command: resolution.command,
            dryRun: options.dryRun === true,
            mode,
            chatId,
          });

          if (options.json) {
            printJson({
              vendor: spec.id,
              scope,
              writer: spec.writerKind,
              coordinatorSeat: vendorHoldsCoordinatorSeat(spec.id),
              command: resolution.command,
              commandSource: resolution.source,
              tier: "agent",
              mode: mode ?? "base",
              chatId: chatId ?? null,
              toolCount: mode === "observer" ? OBSERVER_TOOL_COUNT : BASE_TOOL_COUNT,
              outcome,
            });
            process.exitCode = outcome.kind === "refused" ? 1 : 0;
            return;
          }

          if (outcome.kind === "refused") {
            printError(outcome.reason);
            if (outcome.hint) {
              process.stderr.write(`  ${outcome.hint}\n`);
            }
            process.exitCode = 1;
            return;
          }
          process.stdout.write(
            renderInstall(
              spec,
              scope,
              resolution.command,
              outcome,
              mode,
              chatId
            )
          );
        } catch (error) {
          failCommand(error, "Failed to install the MCP server.");
        }
      }
    );

  mcp
    .command("uninstall")
    .argument("<vendor>", `which CLI to remove from (${installableVendorTokens()})`)
    .description(
      `Remove exactly the '${MUON_MCP_ENTRY_NAME}' entry MUON wrote, and nothing else`
    )
    .option("--scope <scope>", `${MCP_CONFIG_SCOPES.join("|")} (default: user)`)
    .option("--json", "print the outcome as JSON")
    .action(
      async (vendorToken: string, options: { scope?: string; json?: boolean }) => {
        try {
          const { io } = resolveDeps();
          const spec = requireVendor(vendorToken);
          const scope = parseScope(options.scope) ?? spec.defaultScope;
          const outcome = uninstallMcpServer(io, spec, scope);

          if (options.json) {
            printJson({ vendor: spec.id, scope, outcome });
            process.exitCode = outcome.kind === "refused" ? 1 : 0;
            return;
          }
          if (outcome.kind === "refused") {
            printError(outcome.reason);
            if (outcome.hint) {
              process.stderr.write(`  ${outcome.hint}\n`);
            }
            process.exitCode = 1;
            return;
          }
          if (outcome.kind === "absent") {
            process.stdout.write(
              `No '${MUON_MCP_ENTRY_NAME}' entry in ${outcome.configPath} — nothing to remove.\n`
            );
            return;
          }
          process.stdout.write(
            [
              `✓ removed '${MUON_MCP_ENTRY_NAME}' from ${vendorLabel(spec.id)} (${scope} scope)`,
              `  file: ${outcome.configPath}`,
              `  via:  ${outcome.via}`,
              `  Every other server and every sibling key in that file was left untouched.`,
              `  Restart ${spec.cli} for it to drop the tools.`,
              "",
            ].join("\n")
          );
        } catch (error) {
          failCommand(error, "Failed to uninstall the MCP server.");
        }
      }
    );

  mcp
    .command("attach")
    .argument(
      "<vendor>",
      `which coordinator-seat CLI to attach (${coordinatorVendorIds().join(" | ")})`
    )
    .description(
      "Mint a governed dispatch seat for a vendor CLI you run yourself (operator-tier; never printed: the capability token)"
    )
    .option(
      "--chat <id>",
      "attach to an existing active chat instead of creating a new one"
    )
    .option(
      "--workspace <path>",
      "workspace for a newly created chat (default: cwd); ignored with --chat"
    )
    .option("--json", "print the outcome as JSON (never includes the token)")
    .action(
      async (
        vendorToken: string,
        options: { chat?: string; workspace?: string; json?: boolean }
      ) => {
        try {
          if (!createClient) {
            throw new Error(
              "muon mcp attach needs a connection to the brain, and this build did not wire one."
            );
          }
          const { io, env } = resolveDeps();
          const spec = requireVendor(vendorToken);
          if (!vendorHoldsCoordinatorSeat(spec.id)) {
            throw new Error(
              `${vendorLabel(spec.id)} does not hold MUON's coordinator seat. attach is only for ${coordinatorVendorIds()
                .map((id) => vendorLabel(id))
                .join(" and ")}.`
            );
          }
          const client = createClient();
          const apiBase = resolveApiBase(
            program.opts<{ apiBase?: string }>().apiBase
          );
          const dataDir = env.MUON_DATA_DIR?.trim() || resolveDataDir();
          const workspacePath = path.resolve(options.workspace ?? process.cwd());
          const chatId = parseChatId(options.chat);

          // Dispatched children (the whole point of Tier C) need a persistent
          // runner. Best-effort, exactly like `muon chat`: a note, never a
          // block — the attach itself does not require one.
          const rawFlags = program.opts<{
            apiBase?: string;
            apiToken?: string;
          }>();
          const runner = await ensureRunner(client, {
            apiBase,
            apiBaseFlag: rawFlags.apiBase,
            apiTokenFlag: rawFlags.apiToken,
          });

          const result = await attachCoordinatorFlow({
            client,
            io,
            apiBase,
            dataDir,
            spec,
            chatId,
            workspacePath,
            // P0-2: the terminal counterpart of the Desktop login gate. Same
            // shared flag parser (1/true/on), so both surfaces read one
            // vocabulary for one policy switch.
            requireGitHubIdentity:
              booleanEnvFlag(env.MUON_REQUIRE_GITHUB_LOGIN) === true,
          });

          // 2 when the BRAIN refused the caller's authority (the flow carries
          // the classification since the reason is a string); 1 otherwise.
          const refusedExit =
            result.kind === "refused" && result.authRefused ? 2 : 1;
          if (options.json) {
            printJson(result);
            process.exitCode = result.kind === "refused" ? refusedExit : 0;
            return;
          }
          if (result.kind === "refused") {
            printError(result.reason);
            if (result.hint) {
              process.stderr.write(`  ${result.hint}\n`);
            }
            process.exitCode = refusedExit;
            return;
          }
          process.stdout.write(renderAttach(spec, result, runner.live));
        } catch (error) {
          failCommand(error, "Failed to attach the coordinator.");
        }
      }
    );

  mcp
    .command("detach")
    .argument(
      "<vendor>",
      `which coordinator-seat CLI to detach (${coordinatorVendorIds().join(" | ")})`
    )
    .description(
      "Revoke a vendor's attached-coordinator seat and revert its MCP config to base"
    )
    .option("--json", "print the outcome as JSON")
    .action(async (vendorToken: string, options: { json?: boolean }) => {
      try {
        if (!createClient) {
          throw new Error(
            "muon mcp detach needs a connection to the brain, and this build did not wire one."
          );
        }
        const { io, env } = resolveDeps();
        const spec = requireVendor(vendorToken);
        const client = createClient();
        const dataDir = env.MUON_DATA_DIR?.trim() || resolveDataDir();

        const result = await detachCoordinatorFlow({ client, io, dataDir, spec });

        if (options.json) {
          printJson(result);
          process.exitCode = result.kind === "partial" ? 1 : 0;
          return;
        }
        process.stdout.write(renderDetach(spec, result));
        process.exitCode = result.kind === "partial" ? 1 : 0;
      } catch (error) {
        failCommand(error, "Failed to detach the coordinator.");
      }
    });

  mcp
    .command("status")
    .description(
      "Explain the tier a hand-started session would get, and name every reason it could be wrong"
    )
    .option(
      "--scope <scope>",
      `report this scope per vendor (${MCP_CONFIG_SCOPES.join("|")}; default: each vendor's own)`
    )
    .option("--json", "print the status report as JSON")
    .action(async (options: { scope?: string; json?: boolean }) => {
      try {
        const { io, env } = resolveDeps();
        const report = buildMcpStatusReport({
          io,
          env,
          scope: parseScope(options.scope),
        });
        if (options.json) {
          printJson(report);
        } else {
          process.stdout.write(renderStatus(report));
        }
        // A failing check is DATA, not a crash — but the exit code has to be
        // honest so a script can gate on it.
        process.exitCode = report.checks.some((check) => check.level === "fail")
          ? 1
          : 0;
      } catch (error) {
        failCommand(error, "Failed to read MCP status.");
      }
    });

  mcp
    .command("probe")
    .description(
      "Ask the INSTALLED server what it actually serves, and compare it to this build"
    )
    .option(
      "--mode <mode>",
      "score against this server mode (default: base, the sub-agent seat)"
    )
    .option("--timeout <ms>", "give the server this long to answer (default 20000)")
    .option("--json", "print the probe verdict as JSON")
    .action(
      async (options: { mode?: string; timeout?: string; json?: boolean }) => {
        try {
          const { io } = resolveDeps();
          // Same resolver `install` uses, so this measures the binary a vendor
          // would spawn — not the one this CLI happens to sit beside.
          const resolution = resolveMuonMcpCommand(io);
          if (!resolution.ok) {
            throw new Error(muonMcpUnresolvedRefusal(resolution.searched));
          }
          const timeoutMs = parseProbeTimeout(options.timeout);
          const mode = options.mode?.trim() || "base";
          const outcome = await probeMcpToolNames({
            command: resolution.command,
            // The mode is the server's own switch. Probing `base` must NOT
            // inherit an exported MUON_MCP_MODE from this shell, or the report
            // describes a server nobody launches.
            env: {
              ...process.env,
              MUON_MCP_MODE: mode === "base" ? "" : mode,
            },
            timeoutMs,
          });
          const verdict = compareLiveTools(outcome.toolNames, mode);

          if (options.json) {
            printJson({
              command: resolution.command,
              commandSource: resolution.source,
              mode,
              verdict,
              failure: outcome.failure ?? null,
            });
          } else {
            process.stdout.write(
              renderProbe(resolution.command, mode, verdict, outcome.failure)
            );
          }
          process.exitCode = probeVerdictIsProblem(verdict) ? 1 : 0;
        } catch (error) {
          failCommand(error, "Failed to probe the MCP server.");
        }
      }
    );
}

/**
 * A bad `--timeout` is REFUSED rather than silently replaced by the default.
 * A probe that quietly waited a different length than asked would make the one
 * measurement this command exists for unreproducible.
 */
export function parseProbeTimeout(raw: string | undefined): number {
  if (raw === undefined) return 20_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1_000) {
    throw new Error(
      `--timeout must be a whole number of milliseconds, at least 1000 (got ${JSON.stringify(raw)})`
    );
  }
  return parsed;
}

export function renderProbe(
  command: string,
  mode: string,
  verdict: McpProbeVerdict,
  failure: string | undefined
): string {
  const lines: string[] = [];
  const mark =
    verdict.level === "ok" ? "OK" : verdict.level === "unevaluated" ? "??" : "!!";
  lines.push(`${mark}  live MCP surface: ${verdict.level}`);
  lines.push(`    command  ${command}`);
  lines.push(`    mode     ${mode}`);
  lines.push(
    `    tools    live ${verdict.liveCount ?? "?"} / defined ${verdict.expectedCount ?? "?"}`
  );
  if (verdict.missing.length > 0) {
    lines.push(`    missing  ${verdict.missing.join(", ")}`);
  }
  if (verdict.extra.length > 0) {
    lines.push(`    unknown  ${verdict.extra.join(", ")}`);
  }
  if (failure) {
    lines.push(`    why      ${failure}`);
  }
  lines.push(`    ${verdict.detail}`);
  return `${lines.join("\n")}\n`;
}

// ───────────────────────────── rendering ────────────────────────────────────

type InstallOutcome = ReturnType<typeof installMcpServer>;

/**
 * §3.1 moment 1 — what MUON says at install time: the exact file, the exact
 * entry, the tier that entry gets, the tool count, and the ONE next action.
 */
function renderInstall(
  spec: InstallableVendorSpec,
  scope: McpConfigScope,
  command: string,
  outcome: Extract<InstallOutcome, { kind: "already-current" | "written" | "dry-run" }>,
  mode?: "observer",
  chatId?: string
): string {
  const lines: string[] = [];
  if (outcome.kind === "dry-run") {
    lines.push(
      `— dry run — nothing was written.`,
      `Would write to: ${outcome.configPath}`,
      `Would run:      ${outcome.via}`
    );
  } else if (outcome.kind === "already-current") {
    lines.push(
      `✓ ${vendorLabel(spec.id)} already registers '${MUON_MCP_ENTRY_NAME}' with exactly this command/mode/chat — nothing was written.`,
      `File: ${outcome.configPath}`
    );
  } else {
    lines.push(
      `✓ ${outcome.replaced ? "updated" : "registered"} '${MUON_MCP_ENTRY_NAME}' with ${vendorLabel(spec.id)} (${scope} scope)`,
      `File: ${outcome.configPath}`,
      `Via:  ${outcome.via}`
    );
  }

  lines.push(
    "",
    outcome.kind === "dry-run"
      ? "Entry that would be written:"
      : outcome.kind === "already-current"
        ? "Entry already in that file:"
        : "Entry now in that file (read back after the write):"
  );
  lines.push(...outcome.entry.split("\n").map((line) => `  ${line}`));

  lines.push(
    "",
    `Command recorded: ${command}`,
    `  Absolute on purpose: a bare 'muon-mcp' is broken for a`,
    `  .dmg-only install, and MUON has no diagnostic inside your own CLI. If the`,
    `  app moves or updates, \`muon mcp status\` will tell you to re-run this.`,
    "",
    "No credential was written:",
    "  no MUON token   — the brain re-mints it on every boot; muon-mcp discovers it",
    "                    from the local 0600 lockfile instead.",
    "  no MUON_API_BASE — writing one would switch OFF that lockfile discovery and",
    "                    the session would 401 on every call.",
    mode === "observer"
      ? "  MUON_MCP_MODE=observer — a positive read-only crew-status inventory; no dispatch, steer, interrupt, ship, merge, approve, or memory-confirm authority."
      : "  no MUON_MCP_MODE — base attached-brain tier only.",
    ...(chatId
      ? [
          `  MUON_CHAT_ID=${chatId} — a durable partition coordinate, not a credential.`,
        ]
      : []),
    "",
    `Tier this entry gets: agent — ${mode === "observer" ? OBSERVER_TOOL_COUNT : BASE_TOOL_COUNT} tools (memory graph, the pre-edit`,
    "  blast-radius + prior-decisions hero, the code-intelligence tier, and peer",
    "  coordination). Never operator: an MCP server cannot present the operator",
    "  credential, so it can never approve, confirm memory, or answer a gate.",
    `  ${vendorLabel(spec.id)} ${seatLine(spec)}`
  );

  if (outcome.kind === "written" && outcome.followUps.length > 0) {
    lines.push("", "Follow-ups:");
    lines.push(...outcome.followUps.map((note) => `  - ${note}`));
  }
  if (spec.notes.length > 0) {
    lines.push("", `About ${vendorLabel(spec.id)} (verified ${spec.verifiedAt}):`);
    lines.push(...spec.notes.map((note) => `  - ${note}`));
  }

  lines.push(
    "",
    "Next:",
    outcome.kind === "dry-run"
      ? `  re-run without --dry-run to write it.`
      : `  1. restart ${spec.cli} (a running session does not pick up a new MCP server)`,
    ...(outcome.kind === "dry-run"
      ? []
      : [
          `  2. \`muon mcp status\` — confirms the tier and re-verifies the command path`,
          `  3. \`muon doctor\` — checks whether ${spec.cli} itself is installed AND logged in.`,
          `     MUON never logs you in to a vendor; it drives your own binary and stores no vendor token.`,
        ]),
    ""
  );
  return lines.join("\n");
}

/**
 * ADR-0028 §3.1 for Tier C — one screen: the seat, the chat, the lease, the
 * honest non-hermetic attestation, and the ONE next action. The capability
 * token is never in `result` at all (attachCoordinatorFlow's return type
 * carries no such field), so there is nothing to redact here.
 */
function renderAttach(
  spec: InstallableVendorSpec,
  result: Extract<AttachCoordinatorFlowResult, { kind: "attached" }>,
  runnerLive: boolean
): string {
  const lines: string[] = [
    `✓ attached ${vendorLabel(spec.id)} as MUON's attached coordinator`,
    `  job:        ${result.jobId}`,
    `  chat:       ${result.chatId}`,
    `  workspace:  ${result.workspacePath}`,
    `  lease:      renews via heartbeat, expires ${result.expiresAt} if the terminal stops`,
    `  attestation: ${result.attestation.posture} — ${result.attestation.claim}`,
    "",
    `No credential was printed here: the exact-job bearer lives ONLY at`,
    `  ${result.capabilityFilePath} (owner-only, mode 0600).`,
    "",
    `Command recorded: ${result.command} [${result.commandSource}]`,
    `Vendor config:    ${describeVendorConfigOutcome(result.vendorConfig)}`,
  ];
  if (!runnerLive) {
    lines.push(
      "",
      "⚠ no MUON runner is online — a `dispatch` from this coordinator will queue until one starts (`muon runner`, or it auto-starts on your next `muon` command)."
    );
  }
  lines.push(
    "",
    "Next:",
    `  1. restart ${spec.cli} (a running session does not pick up a new MCP server or mode)`,
    `  2. run \`muon mcp status\` — Tier C now reads yes for this vendor`,
    `  3. \`muon mcp detach ${spec.id}\` (or close this terminal) to release the seat — the lease also lapses on its own within ~2 minutes of the session going quiet`,
    ""
  );
  return lines.join("\n");
}

/**
 * `attachCoordinatorFlow` only ever returns an "attached" result AFTER its own
 * vendor-config write succeeded (a `refused` write is rolled back into a
 * top-level `{kind: "refused"}`, never surfaced as an "attached" result) — but
 * `InstallOutcome`'s type is the full four-way union regardless, so this stays
 * exhaustive rather than asserting the narrower case away.
 */
function describeVendorConfigOutcome(outcome: InstallOutcome): string {
  switch (outcome.kind) {
    case "already-current":
      return `already registered attached-coordinator mode — ${outcome.configPath}`;
    case "written":
      return `${outcome.configPath} (via ${outcome.via})`;
    case "dry-run":
      return `${outcome.configPath} (dry-run, via ${outcome.via})`;
    case "refused":
      return `unexpectedly unresolved (${outcome.reason})`;
  }
}

function renderDetach(
  spec: InstallableVendorSpec,
  result: DetachCoordinatorFlowResult
): string {
  if (result.kind === "not-attached") {
    return `No attached-coordinator seat found for ${vendorLabel(spec.id)} — nothing to detach.\n`;
  }
  const lines = [
    result.kind === "partial"
      ? `✗ ${vendorLabel(spec.id)} detach is incomplete`
      : `✓ detached ${vendorLabel(spec.id)}'s coordinator seat`,
    `  job:                ${result.jobId ?? "none found (seat was already clear backend-side)"}`,
    `  capability file:    ${
      result.capabilityFileRemoved
        ? "removed"
        : result.kind === "partial"
          ? "cleanup not confirmed — see Notes"
          : "was already absent"
    }`,
    `  vendor MCP config:  ${
      result.vendorConfigReverted
        ? "reverted to base (mode/capability-file keys cleared, every sibling server untouched)"
        : result.kind === "partial"
          ? "cleanup not confirmed — see Notes"
          : "no attach-mode entry found to revert"
    }`,
  ];
  if (result.notes.length > 0) {
    lines.push("", "Notes:");
    lines.push(...result.notes.map((note) => `  - ${note}`));
  }
  lines.push("");
  return lines.join("\n");
}

const LEVEL_GLYPH = { ok: "✓", warn: "!", fail: "✗" } as const;

function renderStatus(report: McpStatusReport): string {
  const lines: string[] = [
    "MUON MCP status — what a session you start yourself would get",
    "",
    `Tier:        ${report.tier}${report.tier === "agent" ? "" : " (no credential would resolve)"} — never operator, by construction`,
    `Tools:       ${report.toolCount}${report.mode ? ` (MUON_MCP_MODE=${report.mode})` : ""}`,
    `API base:    ${report.apiBase}  [source: ${report.baseSource}]`,
    `Bearer from: ${report.tokenSource}`,
    `Brain:       ${
      report.brainRunning
        ? `running (pid ${report.pid}, port ${report.port})`
        : "not running"
    }`,
    `Data dir:    ${report.dataDir}`,
    `muon-mcp:    ${report.resolvedCommand ?? "NOT RESOLVABLE"}${
      report.resolvedCommandSource ? `  [${report.resolvedCommandSource}]` : ""
    }`,
    `Tier C:      ${report.wouldGetTierC ? "yes (non-hermetic)" : "no"} — ${report.tierCReason}`,
    "",
    "Checks (every reason this could be wrong):",
  ];
  for (const check of report.checks) {
    lines.push(`  ${LEVEL_GLYPH[check.level]} ${check.id}`);
    lines.push(...wrap(check.detail, 74).map((line) => `      ${line}`));
  }

  lines.push("", "Vendors:");
  for (const row of report.vendors) {
    lines.push("", `  ${row.label} (${row.vendor})`);
    lines.push(
      `    registered:       ${row.installed ? "yes" : "no"} (${row.scope} scope)`,
      `    config:           ${row.configPath}`,
      `    writer:           ${row.writer === "vendor-cli" ? `${row.cli}'s own \`mcp add\`` : "muon (direct JSON write)"}`,
      `    ${`${row.cli}:`.padEnd(18)}${row.cliInstalled ? row.cliPath : "not on PATH"}`,
      `    command:          ${row.command ?? "—"}`,
      `    mode:             ${row.mode ?? "base"}`,
      `    chat:             ${row.chatId ?? "global / not configured"}`,
      `    commandResolves:  ${
        row.commandResolves === null ? "n/a" : row.commandResolves ? "yes" : "NO — re-run install"
      }`,
      `    installable:      yes`,
      `    coordinatorSeat:  ${row.coordinatorSeat ? "yes" : "no (can use MUON's brain, can never coordinate a crew)"}`
    );
    for (const reason of row.reasons) {
      lines.push(`    ${LEVEL_GLYPH[reason.level]} ${reason.id}`);
      lines.push(...wrap(reason.detail, 70).map((line) => `        ${line}`));
    }
  }

  // F8 (ADR-0019 R2 slice): the drift verdicts + the authority explanation,
  // derived purely from this report — same assessor the desktop panel renders.
  const drift = assessMcpDrift(report);
  lines.push("", "Drift (observed registration vs what install would record now):");
  for (const vendor of drift.vendors) {
    lines.push(`  ${vendor.label}: ${vendor.verdict}`);
    for (const finding of vendor.findings) {
      lines.push(...wrap(finding.detail, 70).map((line) => `      ${line}`));
      if (finding.fix) {
        lines.push(`      fix: ${finding.fix}`);
      }
    }
  }
  lines.push("", "Authority:");
  lines.push(...wrap(drift.authority, 74).map((line) => `  ${line}`));

  lines.push(
    "",
    "MUON governs what an installed session may do to the crew and to memory.",
    "It does NOT govern what that session does to your filesystem — your own",
    "vendor permissions do, and you are sitting there answering them.",
    ""
  );
  return lines.join("\n");
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") {
      line = word;
    } else if (`${line} ${word}`.length <= width) {
      line = `${line} ${word}`;
    } else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") {
    out.push(line);
  }
  return out;
}

/** Exported for the TUI/desktop parity surfaces (§5) and the tests. */
export { INSTALLABLE_VENDORS };
export type { McpVendorStatus };
