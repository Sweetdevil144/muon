import type { Command } from "commander";
import {
  INSTALLABLE_VENDORS,
  defaultVendorIo,
  installMcpServer,
  muonMcpUnresolvedRefusal,
  readVendorEntry,
  resolveMuonMcpCommand,
  type InstallableVendorSpec,
  type McpVendorIo,
} from "@muon/client/mcp-vendor-config";
import { readEnrolment, writeEnrolment } from "@muon/client/enrolment";
import { failCommand } from "../lib/refusal.js";
import { printJson } from "../lib/output.js";

/**
 * ONE COMMAND THAT SETS MUON UP, and one that repairs it.
 *
 * Registering MUON used to be per-vendor, by hand, with nothing written down:
 * `muon mcp install claude-code`, then again for codex, and if a vendor's
 * config later drifted there was nothing to restore FROM. Every user — dev or
 * not — had to re-derive their own setup from a manual.
 *
 * `muon setup` asks the one question that matters (which of your agent CLIs
 * should hold MUON?), installs into all of them, and REMEMBERS the answer.
 * `muon setup --repair` re-applies exactly that answer, which is what makes a
 * broken install fixable without a human re-learning the topology.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: mint anything. It writes vendor config
 * files pointing at the `muon-mcp` binary, and nothing else. The durable
 * registration carries no token, no capability file and no lease — which is
 * exactly why it survives restarts and reboots without ceremony. An attached
 * COORDINATOR seat (the tier that can dispatch and ship) is a separate,
 * session-scoped act with its own lease, and is never re-applied from here.
 */
export function registerSetupCommands(
  program: Command,
  deps?: { io?: McpVendorIo; dataDir?: string }
) {
  const io = () => deps?.io ?? defaultVendorIo();

  program
    .command("setup")
    .description(
      "Give MUON to your agent CLIs in one step, and remember the choice"
    )
    .option(
      "--vendors <list>",
      "comma-separated vendor ids (default: every agent CLI detected on this machine)"
    )
    .option("--all", "every vendor MUON can install into, detected or not")
    .option(
      "--repair",
      "re-apply the choice already recorded on this machine (fixes a drifted config)"
    )
    .option("--observer", "register the READ-ONLY toolset instead of the full one")
    .option(
      "--force",
      "replace an attached-coordinator registration with the plain durable one"
    )
    .option("--json", "print the outcome as JSON")
    .action(
      async (options: {
        vendors?: string;
        all?: boolean;
        repair?: boolean;
        observer?: boolean;
        force?: boolean;
        json?: boolean;
      }) => {
        try {
          const vendorIo = io();
          const detected = detectVendors(vendorIo);
          const mode = options.observer ? ("observer" as const) : ("base" as const);

          let chosen: InstallableVendorSpec[];
          let source: string;
          if (options.repair) {
            const stored = readEnrolment(deps?.dataDir);
            if (!stored.ok) {
              // ABSENT and CHOSE-NOTHING are different, and only one of them
              // has a remedy that is not "run setup".
              throw new Error(
                stored.reason === "absent"
                  ? "Nothing to repair: this machine has no recorded setup yet. Run `muon setup` to choose which agent CLIs hold MUON."
                  : `The recorded setup could not be read (${stored.detail}). Run \`muon setup\` to record it again.`
              );
            }
            chosen = stored.enrolment.vendors
              .map((id) => INSTALLABLE_VENDORS.find((spec) => spec.id === id))
              .filter((spec): spec is InstallableVendorSpec => Boolean(spec));
            source = "the setup recorded on this machine";
          } else if (options.vendors) {
            chosen = parseVendorList(options.vendors);
            source = "--vendors";
          } else if (options.all) {
            chosen = [...INSTALLABLE_VENDORS];
            source = "--all";
          } else {
            // THE DEFAULT IS WHAT IS ACTUALLY INSTALLED. Registering MUON into
            // a CLI the user does not have produces a config file for a tool
            // that will never read it, and a "success" that means nothing.
            chosen = detected.installed;
            source = "the agent CLIs detected on this machine";
          }

          if (chosen.length === 0) {
            const hint = detected.missing.length
              ? ` MUON can install into ${detected.missing.map((spec) => spec.id).join(", ")} once one of them is on your PATH.`
              : "";
            throw new Error(
              `No agent CLI to set up — none detected.${hint} Pass --vendors to name one anyway.`
            );
          }

          const resolution = resolveMuonMcpCommand(vendorIo);
          if (!resolution.ok) {
            // The SAME refusal `muon mcp install` gives, one author.
            throw new Error(muonMcpUnresolvedRefusal(resolution.searched));
          }

          const results = chosen.map((spec) => {
            // NEVER SILENTLY DOWNGRADE A COORDINATOR SEAT.
            //
            // An attached-coordinator registration is a deliberate upgrade: it
            // carries the tier that can dispatch, ship and interrupt. Writing
            // the base entry over it takes 14 tools away from the next session
            // that vendor starts, and nothing would have said so — found by
            // running this against a machine that had one, which turned a
            // 44-tool seat into a 30-tool one in silence.
            //
            // Setup is for the durable registration. Changing tiers is
            // `muon mcp attach` / `detach`, where the human is choosing it.
            const current = readVendorEntry(spec, spec.defaultScope, vendorIo.roots);
            if (
              !options.force &&
              current.kind === "present" &&
              current.environment?.MUON_MCP_MODE === "attached-coordinator"
            ) {
              return {
                vendor: spec.id,
                label: spec.id,
                outcome: {
                  kind: "refused" as const,
                  reason:
                    "already holds an attached COORDINATOR seat (the tier that can dispatch and ship). Leaving it alone — `muon mcp detach` first, or pass --force, if you want the plain durable registration instead.",
                },
              };
            }
            const outcome = installMcpServer(vendorIo, {
              spec,
              scope: spec.defaultScope,
              command: resolution.command,
              dryRun: false,
              ...(mode === "observer" ? { mode } : {}),
            });
            return { vendor: spec.id, label: spec.id, outcome };
          });

          // RECORD THE DECISION, not the outcome: a vendor whose write failed
          // is still one the human chose, and `--repair` must try it again
          // rather than quietly dropping it from their setup.
          const enrolment = writeEnrolment(
            { vendors: chosen.map((spec) => spec.id), mode },
            deps?.dataDir
          );

          if (options.json) {
            printJson({
              source,
              mode,
              command: resolution.command,
              vendors: results.map((row) => ({
                vendor: row.vendor,
                outcome: row.outcome.kind,
                ...(row.outcome.kind === "refused"
                  ? { reason: row.outcome.reason }
                  : {}),
              })),
              recorded: enrolment,
            });
            return;
          }

          const lines: string[] = [];
          // A COORDINATOR SEAT LEFT ALONE IS NOT A FAILURE. It is setup doing
          // the right thing, and exiting non-zero for it would make a healthy
          // machine look broken to any script that checks.
          const skipped = results.filter(
            (row) =>
              row.outcome.kind === "refused" &&
              row.outcome.reason.includes("COORDINATOR seat")
          );
          const failures = results.filter(
            (row) => row.outcome.kind === "refused" && !skipped.includes(row)
          );
          lines.push(
            failures.length === 0
              ? `✓ MUON is set up in ${results.length - skipped.length} agent CLI(s) — chosen from ${source}.`
              : `MUON set up in ${results.length - failures.length - skipped.length} of ${results.length} agent CLI(s).`
          );
          for (const row of results) {
            lines.push(
              row.outcome.kind !== "refused"
                ? `  ✓ ${row.label}`
                : skipped.includes(row)
                  ? `  · ${row.label}: ${row.outcome.reason}`
                  : `  ✗ ${row.label}: ${row.outcome.reason}`
            );
          }
          lines.push("");
          lines.push(
            "This registration is DURABLE: no token, no lease, nothing to renew. It survives restarts and reboots."
          );
          lines.push(
            "Restart any of those CLIs that are currently running — a live session keeps the server it already spawned."
          );
          if (failures.length > 0) {
            lines.push("");
            lines.push(
              "Fix the reasons above and run `muon setup --repair` — your choice is recorded, so you never have to re-pick."
            );
          }
          process.stdout.write(`${lines.join("\n")}\n`);
          process.exitCode = failures.length > 0 ? 1 : 0;
        } catch (error) {
          failCommand(error, "Setup failed.");
        }
      }
    );
}

/** Split the installable vendors by whether their CLI is actually present. */
export function detectVendors(io: McpVendorIo): {
  installed: InstallableVendorSpec[];
  missing: InstallableVendorSpec[];
} {
  const installed: InstallableVendorSpec[] = [];
  const missing: InstallableVendorSpec[] = [];
  for (const spec of INSTALLABLE_VENDORS) {
    (io.which(spec.cli) ? installed : missing).push(spec);
  }
  return { installed, missing };
}

function parseVendorList(raw: string): InstallableVendorSpec[] {
  const tokens = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  return tokens.map((token) => {
    const spec = INSTALLABLE_VENDORS.find(
      (candidate) =>
        candidate.id === token || candidate.aliases.includes(token)
    );
    if (!spec) {
      // Named and unknown is a REFUSAL, never a silent skip: a typo that
      // installs nothing while reporting success is how someone believes they
      // are set up and is not.
      throw new Error(
        `'${token}' is not an agent CLI MUON can install into. Known: ${INSTALLABLE_VENDORS.map((candidate) => candidate.id).join(", ")}.`
      );
    }
    return spec;
  });
}

/**
 * Re-register the vendors the human chose that are no longer registered.
 *
 * ONLY the drifted ones, and only ones already in the record: repair restores
 * a decision, it never makes one. A vendor the human never chose cannot be
 * added here however broken the machine looks.
 */
export function repairEnrolment(
  io: McpVendorIo,
  dataDir?: string
): Array<{ vendor: string; ok: boolean; reason?: string }> {
  const health = enrolmentHealth(io, dataDir);
  if (health.drifted.length === 0) return [];
  const stored = readEnrolment(dataDir);
  const mode = stored.ok ? stored.enrolment.mode : "base";
  const resolution = resolveMuonMcpCommand(io);
  if (!resolution.ok) {
    return health.drifted.map((vendor) => ({
      vendor,
      ok: false,
      reason: muonMcpUnresolvedRefusal(resolution.searched),
    }));
  }
  return health.drifted.map((vendor) => {
    const spec = INSTALLABLE_VENDORS.find((candidate) => candidate.id === vendor);
    if (!spec) {
      return { vendor, ok: false, reason: "unknown vendor in the record" };
    }
    const outcome = installMcpServer(io, {
      spec,
      scope: spec.defaultScope,
      command: resolution.command,
      dryRun: false,
      ...(mode === "observer" ? { mode } : {}),
    });
    return outcome.kind === "refused"
      ? { vendor, ok: false, reason: outcome.reason }
      : { vendor, ok: true };
  });
}

/** Read-only view of what a repair WOULD do, for `muon doctor`. */
export function enrolmentHealth(
  io: McpVendorIo,
  dataDir?: string
): {
  status: "never-set-up" | "unreadable" | "healthy" | "drifted";
  detail: string;
  drifted: string[];
} {
  const stored = readEnrolment(dataDir);
  if (!stored.ok) {
    return stored.reason === "absent"
      ? {
          status: "never-set-up",
          detail:
            "No recorded setup on this machine. Run `muon setup` to give MUON to your agent CLIs.",
          drifted: [],
        }
      : {
          status: "unreadable",
          detail: `The recorded setup could not be read (${stored.detail}). Run \`muon setup\` to record it again.`,
          drifted: [],
        };
  }
  const drifted: string[] = [];
  for (const id of stored.enrolment.vendors) {
    const spec = INSTALLABLE_VENDORS.find((candidate) => candidate.id === id);
    if (!spec) continue;
    const entry = readVendorEntry(spec, spec.defaultScope, io.roots);
    // Anything other than a present, MUON-owned entry is drift: the human
    // chose this vendor and it is no longer registered.
    if (entry.kind !== "present") {
      drifted.push(id);
    }
  }
  return drifted.length === 0
    ? {
        status: "healthy",
        detail: `MUON is registered in every agent CLI you chose (${stored.enrolment.vendors.join(", ") || "none"}).`,
        drifted: [],
      }
    : {
        status: "drifted",
        detail: `MUON is missing from ${drifted.join(", ")} — you chose ${drifted.length === 1 ? "it" : "them"} but the config no longer holds MUON. Run \`muon setup --repair\`.`,
        drifted,
      };
}
