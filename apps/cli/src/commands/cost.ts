import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import { MuonApiClient } from "../lib/api-client.js";
import { printJson } from "../lib/output.js";
import { parseCostCapInput } from "@muon/client/cost-cap";

/**
 * ADR-0036 — what a mission cost, and the brake a human can put on it.
 *
 *   muon cost <chat>                  what it has spent, and the cap
 *   muon cost cap <chat> <usd|none>   set, raise, lower, or clear the cap
 *   muon cost default <usd|none>      what NEW chats start with
 *
 * TWO THINGS THIS COMMAND WILL NOT DO, both structural:
 *
 *  1. It never prints a bare number. Every figure comes from `summary`, the
 *     one renderer, so the `≥` and the reporting-lane count travel with it.
 *     Cost is vendor-reported or unknown — today only Claude reports dollars,
 *     so PARTIAL coverage is the normal case in a mixed crew, and a total
 *     presented as *the* cost invites exactly the confident wrong decision
 *     this feature exists to prevent.
 *  2. It never estimates. No tokens × price, at any layer, for any lane.
 */
export function registerCostCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const cost = program
    .command("cost")
    .description("What a mission has cost, and the dollar cap on it");

  cost
    .command("show <chatId>", { isDefault: true })
    .description("Observed spend (a lower bound) and the cap, with coverage")
    .option("--json", "Print as JSON")
    .action(async (chatId: string, options: { json?: boolean }) => {
      try {
        const view = await createClient().getMissionCost(chatId);
        if (options.json) {
          printJson(view);
          return;
        }
        const lines = [view.summary];
        if (view.laneCosts.length > 0) {
          lines.push("", "per lane:");
          for (const lane of view.laneCosts) {
            lines.push(
              lane.reported
                ? `  ${lane.laneId}: $${lane.usd.toFixed(2)}`
                : // NOT "$0.00". A lane that reports nothing is UNKNOWN, and
                  // rendering it as zero is the quieter version of the same lie
                  // a total tells.
                  `  ${lane.laneId}: unknown — this vendor does not report dollars`
            );
          }
        }
        if (view.refusesDispatch) {
          lines.push(
            "",
            "Further dispatch into this mission is refused. Raise or clear the cap to continue; nothing already running was stopped."
          );
        }
        process.stdout.write(`${lines.join("\n")}\n`);
      } catch (error) {
        failCommand(error, "Could not read this mission's cost.");
      }
    });

  cost
    .command("cap <chatId> <usd>")
    .description(
      "Set this mission's dollar cap. `none` clears it. Refuses NEW work only — never interrupts a running lane"
    )
    .option("--json", "Print as JSON")
    .action(
      async (chatId: string, usd: string, options: { json?: boolean }) => {
        try {
          const capUsd = parseCapArgument(usd);
          const view = await createClient().setMissionCostCap(chatId, capUsd);
          if (options.json) {
            printJson(view);
            return;
          }
          const lines = [
            capUsd === null
              ? `cleared the cap on ${chatId}.`
              : `cap on ${chatId} is now $${capUsd.toFixed(2)}.`,
            view.summary,
          ];
          if (view.refusesDispatch) {
            // An operator who caps BELOW what is already spent learns it here,
            // not from the next dispatch failing with no sense of when it
            // changed.
            lines.push(
              "",
              "This mission has already met that cap, so the next dispatch into it is refused. Work already running is untouched."
            );
          }
          process.stdout.write(`${lines.join("\n")}\n`);
        } catch (error) {
          failCommand(error, "Could not set the cap.");
        }
      }
    );

  cost
    .command("default [usd]")
    .description(
      "The cap NEW chats start with. `none` clears it. Never changes a mission that already exists"
    )
    .option("--json", "Print as JSON")
    .action(async (usd: string | undefined, options: { json?: boolean }) => {
      try {
        const client = createClient();
        const capUsd =
          usd === undefined
            ? await client.getMissionCostCapDefault()
            : await client.setMissionCostCapDefault(parseCapArgument(usd));
        if (options.json) {
          printJson({ capUsd });
          return;
        }
        process.stdout.write(
          capUsd === null
            ? "new chats start with no cost cap.\n"
            : `new chats start with a $${capUsd.toFixed(2)} cost cap.\n` +
                "Missions that already exist keep the cap they were created with.\n"
        );
      } catch (error) {
        failCommand(error, "Could not read or set the default cap.");
      }
    });
}

/**
 * `none` clears; anything else must be a positive number.
 *
 * The RULE itself lives in `@muon/client/cost-cap`, shared with the desk — two
 * surfaces that take a cap from a human must refuse the same inputs with the
 * same words, or a `0` typed in one place means something different from a `0`
 * typed in the other. This wrapper only turns the shared result back into the
 * throw the command layer expects.
 */
function parseCapArgument(raw: string): number | null {
  const parsed = parseCostCapInput(raw);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.capUsd;
}
