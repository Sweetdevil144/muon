import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import { runLaneDoctor } from "@muon/core";
import { laneProfileSchema, type LaneProfile } from "@muon/client";
import { MuonApiClient } from "../lib/api-client.js";
import { printJson, printLane } from "../lib/output.js";

async function requireLaneByKey(client: MuonApiClient, laneKey: string) {
  const lanes = await client.listLanes();
  const lane = lanes.find((entry) => entry.key === laneKey);
  if (!lane) {
    throw new Error(
      `Lane key '${laneKey}' not found. Available: ${lanes.map((l) => l.key).join(", ")}`
    );
  }
  return lane;
}

/**
 * Parses `key=value` pairs into a lane-profile patch. Dotted keys and JSON
 * values are supported so any typed or passthrough field is settable:
 *   model=opus  permissionMode=full-auto  extraArgs='["--max-turns","5"]'
 *   rawConfig.includeCoAuthoredBy=false
 */
export function parseProfileAssignments(
  pairs: string[]
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator < 1) {
      throw new Error(`Expected key=value, got '${pair}'`);
    }
    const key = pair.slice(0, separator).trim();
    const rawValue = pair.slice(separator + 1);
    let value: unknown = rawValue;
    try {
      value = JSON.parse(rawValue);
    } catch {
      // keep as string
    }

    const segments = key.split(".");
    let cursor = patch;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]!;
      cursor[segment] ??= {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1]!] = value;
  }
  return patch;
}

export function registerLaneCommands(program: Command, createClient: () => MuonApiClient) {
  const lane = program.command("lane").description("Lane commands");

  lane
    .command("list")
    .description("List all known lanes")
    .option("--json", "Print as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const lanes = await createClient().listLanes();
        if (options.json) {
          printJson({ lanes });
          return;
        }

        lanes.forEach(printLane);
      } catch (error) {
        failCommand(error, "Failed to list lanes.");
      }
    });

  lane
    .command("doctor")
    .description("Check lane adapter health/capabilities for backend lanes")
    .option("--json", "Print as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const lanes = await createClient().listLanes();
        const report = await runLaneDoctor(
          lanes.map((laneItem) => ({
            id: laneItem.id,
            key: laneItem.key,
            name: laneItem.name,
            role: laneItem.role,
            status: laneItem.status,
          }))
        );

        if (options.json) {
          printJson(report);
          return;
        }

        process.stdout.write(
          `summary: total=${report.summary.totalLanes}, mapped=${report.summary.adaptersFound}, healthy=${report.summary.healthyAdapters}, unavailable=${report.summary.unavailableAdapters}\n`
        );
        report.records.forEach((record) => {
          if (!record.adapterFound) {
            process.stdout.write(
              `- ${record.lane.name}: no adapter mapped for key '${record.lane.key}'\n`
            );
            return;
          }

          process.stdout.write(
            `- ${record.lane.name}: ${record.health?.status ?? "unknown"} | stream=${record.capabilities?.canStreamEvents ? "yes" : "no"} interrupt=${record.capabilities?.canInterrupt ? "yes" : "no"} background=${record.capabilities?.canBackground ? "yes" : "no"}\n`
          );
        });
      } catch (error) {
        failCommand(error, "Failed lane doctor check.");
      }
    });

  const config = lane
    .command("config")
    .description("Lane profile: configure every vendor feature through MUON");

  config
    .command("get")
    .description("Show the lane's profile")
    .requiredOption("--lane <laneKey>", "Lane key")
    .action(async (options: { lane: string }) => {
      try {
        const client = createClient();
        const laneRecord = await requireLaneByKey(client, options.lane);
        const { profile, version } = await client.getLaneProfile(laneRecord.id);
        printJson({ lane: options.lane, version, profile });
      } catch (error) {
        failCommand(error, "Config get failed.");
      }
    });

  config
    .command("set")
    .description("Set profile fields (key=value, dotted keys + JSON values)")
    .requiredOption("--lane <laneKey>", "Lane key")
    .argument("<assignments...>", "key=value pairs")
    .action(async (assignments: string[], options: { lane: string }) => {
      try {
        const client = createClient();
        const laneRecord = await requireLaneByKey(client, options.lane);
        const { profile: current } = await client.getLaneProfile(laneRecord.id);

        const patch = parseProfileAssignments(assignments);
        const merged = laneProfileSchema.parse({
          ...current,
          ...patch,
          ...(patch.rawConfig
            ? {
                rawConfig: {
                  ...current.rawConfig,
                  ...(patch.rawConfig as Record<string, unknown>),
                },
              }
            : {}),
        }) as LaneProfile;

        const result = await client.putLaneProfile(laneRecord.id, merged);
        printJson({ lane: options.lane, version: result.version, profile: result.profile });
      } catch (error) {
        failCommand(error, "Config set failed.");
      }
    });

  config
    .command("unset")
    .description("Reset the lane profile to defaults")
    .requiredOption("--lane <laneKey>", "Lane key")
    .action(async (options: { lane: string }) => {
      try {
        const client = createClient();
        const laneRecord = await requireLaneByKey(client, options.lane);
        const result = await client.putLaneProfile(
          laneRecord.id,
          laneProfileSchema.parse({})
        );
        printJson({ lane: options.lane, version: result.version, profile: result.profile });
      } catch (error) {
        failCommand(error, "Config unset failed.");
      }
    });
}
