import {
  mergeProfilePatch,
  resolveVendorAction,
} from "@muon/adapters/vendor-capabilities";
import { laneProfileSchema, type LaneProfile } from "@muon/client";
import {
  normalizeDesktopPresets,
  type DesktopPreset,
  type DesktopPresetVendor,
} from "./presets.js";

function stripClaudeEffortArgs(args: string[]): string[] {
  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--effort") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--effort=")) {
      continue;
    }
    next.push(arg);
  }
  return next;
}

function clearPresetOwnedEffort(
  profile: LaneProfile,
  vendor: DesktopPresetVendor
): LaneProfile {
  if (vendor === "claude-code") {
    return {
      ...profile,
      extraArgs: stripClaudeEffortArgs(profile.extraArgs),
    };
  }
  const { model_reasoning_effort: _priorEffort, ...rawConfig } =
    profile.rawConfig;
  return { ...profile, rawConfig };
}

/**
 * Main-process-only profile application. Apply exactly the three existing
 * vendor-action channels a preset owns: model, reasoning effort, and a
 * non-bypass permission mode. The base profile's tools, MCP servers, sandbox,
 * context, directories, env, and deny rules are preserved by construction.
 */
export function applyDesktopPresetToProfile(
  profile: LaneProfile,
  presetInput: DesktopPreset
): LaneProfile {
  const preset = normalizeDesktopPresets([presetInput])[0];
  if (!preset) {
    throw new Error("Preset is invalid or requests an unsupported capability.");
  }

  let next = clearPresetOwnedEffort(
    laneProfileSchema.parse(profile),
    preset.vendor
  );
  const actions = [
    resolveVendorAction(preset.vendor, "model", {
      mode: "one-shot",
      args: [preset.model],
    }),
    resolveVendorAction(preset.vendor, "effort", {
      mode: "one-shot",
      args: [preset.effort],
    }),
    resolveVendorAction(preset.vendor, "permission-mode", {
      mode: "one-shot",
      args: [preset.permission],
    }),
  ];

  for (const resolved of actions) {
    if (
      !resolved.supported ||
      resolved.gate !== "none" ||
      !resolved.profilePatch
    ) {
      throw new Error(
        resolved.reason ?? "Preset action is not safely available for this lane."
      );
    }
    next = mergeProfilePatch(next, resolved.profilePatch);
  }

  return laneProfileSchema.parse(next);
}
