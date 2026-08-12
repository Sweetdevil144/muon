import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import { harnessConfigSchema } from "@muon/protocol";
import { MuonApiClient } from "../lib/api-client.js";
import { printJson } from "../lib/output.js";

type HarnessCreateOptions = {
  key: string;
  name: string;
  description?: string;
  lane?: string;
  config?: string;
  json?: boolean;
};

function parseConfigJson(raw: string | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("config must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `--config is not valid JSON: ${error instanceof Error ? error.message : error}`
    );
  }
}

export function registerHarnessCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const harness = program
    .command("harness")
    .description(
      "Named execution constraint bundles merged over lane profiles at dispatch"
    );

  harness
    .command("list")
    .description("List the harness library")
    .option("--json", "Print as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const client = createClient();
        const harnesses = await client.listHarnesses();
        if (options.json) {
          printJson({ harnesses });
          return;
        }
        if (harnesses.length === 0) {
          process.stdout.write("no harnesses yet, muon harness create ...\n");
          return;
        }
        for (const entry of harnesses) {
          process.stdout.write(
            `${entry.key.padEnd(16)} v${entry.version}  ${entry.name}, ${entry.config.description || "(no description)"}\n`
          );
        }
      } catch (error) {
        failCommand(error, "Harness list failed.");
      }
    });

  harness
    .command("show")
    .description("Show one harness (full config)")
    .requiredOption("--key <key>", "Harness key")
    .option("--json", "Print as JSON")
    .action(async (options: { key: string; json?: boolean }) => {
      try {
        const client = createClient();
        const record = await client.getHarness(options.key);
        if (options.json) {
          printJson({ harness: record });
          return;
        }
        process.stdout.write(`${record.key} v${record.version}, ${record.name}\n`);
        process.stdout.write(`${JSON.stringify(record.config, null, 2)}\n`);
      } catch (error) {
        failCommand(error, "Harness show failed.");
      }
    });

  harness
    .command("create")
    .description("Create or replace a harness (PUT semantics)")
    .requiredOption("--key <key>", "Harness key (kebab-case)")
    .requiredOption("--name <name>", "Display name")
    .option("--description <text>", "What this harness is for")
    .option("--lane <laneKey>", "Make the harness lane-specific")
    .option(
      "--config <json>",
      "Full harnessConfig JSON (overrides --description/--lane)"
    )
    .option("--json", "Print as JSON")
    .action(async (options: HarnessCreateOptions) => {
      try {
        const client = createClient();
        const base = parseConfigJson(options.config);
        const config = harnessConfigSchema.parse({
          ...(options.description ? { description: options.description } : {}),
          ...(options.lane ? { laneKey: options.lane } : {}),
          ...base,
        });

        // A harness that pre-authorizes full autonomy must be a deliberate,
        // visible human choice, never a silent default.
        if (config.profileOverlay.permissionMode === "full-auto") {
          process.stderr.write(
            "warning: this harness sets permissionMode=full-auto, lanes will not ask before acting\n"
          );
        }

        const record = await client.putHarness(options.key, {
          name: options.name,
          config,
        });
        if (options.json) {
          printJson({ harness: record });
        } else {
          process.stdout.write(`harness '${record.key}' saved (v${record.version})\n`);
        }
      } catch (error) {
        failCommand(error, "Harness create failed.");
      }
    });
}
