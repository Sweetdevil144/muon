import type { Command } from "commander";
import { describeEnabledItem, describeImportedItem } from "@muon/protocol";
import { failCommand } from "../lib/refusal.js";
import { MuonApiClient } from "../lib/api-client.js";
import { printJson } from "../lib/output.js";

/**
 * ADR-0038 — SHOW the user the MCP servers their vendor CLIs already have, and
 * let a human hand ONE of them to ONE lane.
 *
 * `muon compat mcp` reads the inventory (operator-tier, no input). Slice 2's
 * verbs were added on 2026-08-09 once the founder answered the ADR's two open
 * questions — MCP servers only (D7), agent-dispatched lanes allowed but bound
 * per lane (D8):
 *
 *   muon compat lane <lane>                      what this lane holds
 *   muon compat enable <lane> <vendor> <name>    one item, one lane
 *   muon compat disable <lane> <vendor> <name>   take it back
 *
 * Every one of them names a single item. There is deliberately no `--all`, no
 * `--vendor` bulk form and no workspace scope: D6/D8 build a lane's imported
 * set by LISTING what it holds, and a new import lands in zero lanes until
 * someone puts it in one. A convenience flag that enabled a vendor's whole
 * config would be the "import everything, then subtract" shape the ADR rejects
 * by name.
 *
 * The rendering comes from `describeImportedItem` / `describeEnabledItem`, so
 * the CLI, and any surface that follows, says the same sentence about the same
 * server — including the list of credentials MUON refused to carry. This file
 * deliberately states no recommendation and no risk score, for the reason those
 * functions' docstrings give: a surface that says "this one looks fine" is one
 * an importer learns to trust instead of reading.
 */
export function registerCompatCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const compat = program
    .command("compat")
    .description(
      "Inspect the agent setup you already have outside MUON (read-only)"
    );

  compat
    .command("mcp")
    .description(
      "List the MCP servers configured in your vendor CLIs. Reads only — nothing is imported, enabled, or made reachable by a lane"
    )
    .option("--json", "Print as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const inventory = await createClient().discoverCompatibilityMcp();

        if (options.json) {
          printJson(inventory);
          return;
        }

        const lines: string[] = [];

        // The FILES first, including the ones that were not there. A user whose
        // servers live somewhere MUON did not look needs to see where it looked
        // — "0 servers" and "I could not read your config" are different facts
        // and this command must never render them the same way.
        lines.push("configs MUON read:");
        for (const source of inventory.sources) {
          const detail =
            source.status === "read"
              ? `${source.items} server(s)`
              : source.status === "absent"
                ? "not present"
                : `unreadable — ${source.reason ?? "no reason given"}`;
          lines.push(`  ${source.vendor} (${source.scope}) ${source.sourcePath}: ${detail}`);
        }

        lines.push("");
        if (inventory.items.length === 0) {
          lines.push("no MCP servers discovered");
        } else {
          lines.push(`discovered ${inventory.items.length} MCP server(s):`);
          for (const item of inventory.items) {
            lines.push(`  - ${describeImportedItem(item)}`);
          }
        }

        if (inventory.unreadable.length > 0) {
          lines.push("");
          lines.push(
            `${inventory.unreadable.length} entr(y/ies) MUON could not read:`
          );
          for (const entry of inventory.unreadable) {
            lines.push(
              `  - ${entry.name} (${entry.vendor}, ${entry.sourcePath}): ${entry.reason}`
            );
          }
        }

        lines.push("");
        // Both of these are the feature working as designed, and a user who is
        // not told either one reads a short list as a complete one.
        lines.push(
          "MUON reads user-scope configs only; a project-scoped .mcp.json is not inspected."
        );
        lines.push(
          "Discovery grants nothing. Nothing above is enabled, and MUON imported no credentials."
        );
        process.stdout.write(`${lines.join("\n")}\n`);
      } catch (error) {
        failCommand(error, "Compatibility discovery failed.");
      }
    });

  compat
    .command("lane <laneKey>")
    .description(
      "Show the imported MCP servers one lane holds, live and drift-disabled alike"
    )
    .option("--json", "Print as JSON")
    .action(async (laneKey: string, options: { json?: boolean }) => {
      try {
        const items = await createClient().listLaneImports(laneKey);
        if (options.json) {
          printJson(items);
          return;
        }
        if (items.length === 0) {
          process.stdout.write(
            `lane ${laneKey} holds no imported MCP servers. An import lands in no lane until a human enables it there.\n`
          );
          return;
        }
        const lines = [`lane ${laneKey} holds ${items.length} imported server(s):`];
        for (const item of items) lines.push(`  - ${describeEnabledItem(item)}`);
        process.stdout.write(`${lines.join("\n")}\n`);
      } catch (error) {
        failCommand(error, "Could not read the lane's imported servers.");
      }
    });

  compat
    .command("enable <laneKey> <vendor> <name>")
    .description(
      "Let ONE discovered MCP server reach ONE lane. Human authority; shows the before/after diff"
    )
    .option("--json", "Print as JSON")
    .action(
      async (
        laneKey: string,
        vendor: string,
        name: string,
        options: { json?: boolean }
      ) => {
        try {
          // The item is NAMED, never described: the backend re-reads the
          // vendor's own configuration and computes the shape and fingerprint
          // itself (D2), so nothing this command sends can make MUON approve a
          // server whose config says something else.
          const result = await createClient().enableLaneImport(laneKey, {
            vendor,
            name,
          });
          if (options.json) {
            printJson(result);
            return;
          }
          const lines = [
            `enabled ${name} (${vendor}) for lane ${laneKey}.`,
            `  before: ${result.diff.before.join(", ") || "(none)"}`,
            `  after:  ${result.diff.after.join(", ") || "(none)"}`,
            `  added:  ${result.diff.added.join(", ") || "(none)"}`,
          ];
          if (result.diff.removed.length > 0) {
            lines.push(`  removed: ${result.diff.removed.join(", ")}`);
          }
          if (result.envNotCarried.length > 0) {
            // Not a refusal — the server launches. But MUON imports env NAMES
            // only (ADR-0038 D5) and materializes an empty env, so anything
            // the item declared is simply absent. A human debugging a server
            // that starts and then misbehaves needs this said out loud.
            lines.push(
              "",
              `MUON does not pass ${result.envNotCarried.length} environment variable(s) this server declares:`,
              `  ${result.envNotCarried.join(", ")}`,
              "It will launch without them. MUON imports names, never values."
            );
          }
          lines.push(
            "",
            "MUON re-checks this server's fingerprint before every governed run. If it changes, MUON disables it for this lane rather than warning about it."
          );
          process.stdout.write(`${lines.join("\n")}\n`);
        } catch (error) {
          failCommand(error, "Enable failed. Nothing was granted.");
        }
      }
    );

  compat
    .command("disable <laneKey> <vendor> <name>")
    .description("Take an imported MCP server back from a lane")
    .option("--json", "Print as JSON")
    .action(
      async (
        laneKey: string,
        vendor: string,
        name: string,
        options: { json?: boolean }
      ) => {
        try {
          const result = await createClient().disableLaneImport(laneKey, {
            vendor,
            name,
          });
          if (options.json) {
            printJson(result);
            return;
          }
          process.stdout.write(
            `disabled ${name} (${vendor}) for lane ${laneKey}.\n` +
              `  before: ${result.diff.before.join(", ") || "(none)"}\n` +
              `  after:  ${result.diff.after.join(", ") || "(none)"}\n`
          );
        } catch (error) {
          failCommand(error, "Disable failed.");
        }
      }
    );
}
