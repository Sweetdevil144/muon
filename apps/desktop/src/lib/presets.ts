import {
  validateModelForVendor,
} from "@muon/adapters/vendor-capabilities";

export const DESKTOP_PRESET_VENDORS = ["claude-code", "codex"] as const;
export type DesktopPresetVendor = (typeof DESKTOP_PRESET_VENDORS)[number];

export const DESKTOP_PRESET_EFFORTS = ["low", "medium", "high"] as const;
export type DesktopPresetEffort = (typeof DESKTOP_PRESET_EFFORTS)[number];

/**
 * Deliberately excludes `full-auto`. Presets are convenient worker-lane
 * configuration, never standing operator consent or a permission-bypass path.
 */
export const DESKTOP_PRESET_PERMISSIONS = [
  "strict",
  "default",
  "auto-edits",
] as const;
export type DesktopPresetPermission =
  (typeof DESKTOP_PRESET_PERMISSIONS)[number];

export type DesktopPreset = {
  id: string;
  name: string;
  vendor: DesktopPresetVendor;
  model: string;
  effort: DesktopPresetEffort;
  permission: DesktopPresetPermission;
};

export const MAX_DESKTOP_PRESETS = 12;

const STOCK_PRESET_SPECS = [
  {
    id: "careful",
    name: "Careful",
    effort: "high" as const,
    permission: "strict" as const,
    models: { "claude-code": "opus", codex: "gpt-5.6-terra" },
  },
  {
    id: "balanced",
    name: "Balanced",
    effort: "medium" as const,
    permission: "default" as const,
    models: { "claude-code": "sonnet", codex: "gpt-5.6-sol" },
  },
  {
    id: "quick",
    name: "Quick",
    effort: "low" as const,
    permission: "auto-edits" as const,
    models: { "claude-code": "haiku", codex: "gpt-5.6-luna" },
  },
] as const;

/** Stock Careful/Balanced/Quick presets for the active Mission vendor. */
export function defaultPresetsForVendor(
  vendor: DesktopPresetVendor = "claude-code"
): DesktopPreset[] {
  return STOCK_PRESET_SPECS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    vendor,
    model: spec.models[vendor],
    effort: spec.effort,
    permission: spec.permission,
  }));
}

export const DEFAULT_DESKTOP_PRESETS: DesktopPreset[] =
  defaultPresetsForVendor("claude-code");

/**
 * Remap stock presets onto the Mission orchestrator vendor so Careful /
 * Balanced / Quick follow Codex when the operator switches seats. Custom
 * presets (non-stock ids) are left untouched.
 */
export function alignStockPresetsToVendor(
  presets: DesktopPreset[],
  vendor: DesktopPresetVendor
): DesktopPreset[] {
  const stockIds = new Set<string>(
    STOCK_PRESET_SPECS.map((spec) => spec.id)
  );
  const allStock =
    presets.length > 0 && presets.every((preset) => stockIds.has(preset.id));
  if (allStock) {
    return defaultPresetsForVendor(vendor);
  }
  return presets.map((preset) => {
    const spec = STOCK_PRESET_SPECS.find((entry) => entry.id === preset.id);
    if (!spec || preset.vendor === vendor) {
      return preset;
    }
    return {
      ...preset,
      vendor,
      model: spec.models[vendor],
    };
  });
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const vendorSet = new Set<string>(DESKTOP_PRESET_VENDORS);
const effortSet = new Set<string>(DESKTOP_PRESET_EFFORTS);
const permissionSet = new Set<string>(DESKTOP_PRESET_PERMISSIONS);

/**
 * Settings files and renderer input are both untrusted. Project them onto the
 * complete preset surface and drop everything else. In particular, no tool,
 * MCP, sandbox, environment, raw-config, argv, token, or full-auto field can
 * survive this boundary.
 */
export function normalizeDesktopPresets(value: unknown): DesktopPreset[] {
  if (value === undefined) {
    return DEFAULT_DESKTOP_PRESETS.map((preset) => ({ ...preset }));
  }
  if (!Array.isArray(value)) {
    return [];
  }

  const presets: DesktopPreset[] = [];
  const ids = new Set<string>();
  for (const candidate of value.slice(0, MAX_DESKTOP_PRESETS)) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const vendor =
      typeof record.vendor === "string" ? record.vendor.trim() : "";
    const model = typeof record.model === "string" ? record.model.trim() : "";
    const effort =
      typeof record.effort === "string" ? record.effort.trim() : "";
    const permission =
      typeof record.permission === "string" ? record.permission.trim() : "";

    if (
      !ID_PATTERN.test(id) ||
      ids.has(id) ||
      name.length < 1 ||
      name.length > 40 ||
      !vendorSet.has(vendor) ||
      model.length < 1 ||
      model.length > 200 ||
      !effortSet.has(effort) ||
      !permissionSet.has(permission)
    ) {
      continue;
    }
    const modelValidation = validateModelForVendor(
      vendor as DesktopPresetVendor,
      model
    );
    if (!modelValidation.ok) {
      continue;
    }

    ids.add(id);
    presets.push({
      id,
      name,
      vendor: vendor as DesktopPresetVendor,
      model,
      effort: effort as DesktopPresetEffort,
      permission: permission as DesktopPresetPermission,
    });
  }
  return presets;
}
