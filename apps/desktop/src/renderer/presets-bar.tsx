import { useState } from "react";
import {
  DESKTOP_PRESET_EFFORTS,
  DESKTOP_PRESET_PERMISSIONS,
  DESKTOP_PRESET_VENDORS,
  MAX_DESKTOP_PRESETS,
  normalizeDesktopPresets,
  type DesktopPreset,
  type DesktopPresetEffort,
  type DesktopPresetPermission,
  type DesktopPresetVendor,
} from "../lib/presets.js";
import { VendorIcon } from "./vendor-icon.js";

type PresetsBarProps = {
  presets: DesktopPreset[];
  activePresetId?: string | null;
  applyingPresetId?: string | null;
  disabled?: boolean;
  status?: string | null;
  onApply: (presetId: string) => Promise<void> | void;
  onSave: (presets: DesktopPreset[]) => Promise<void> | void;
};

function nextPresetId(name: string, presets: DesktopPreset[]): string {
  const stem =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "preset";
  const ids = new Set(presets.map((preset) => preset.id));
  if (!ids.has(stem)) {
    return stem;
  }
  for (let suffix = 2; suffix <= MAX_DESKTOP_PRESETS + 1; suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!ids.has(candidate)) {
      return candidate;
    }
  }
  return `${stem}-${Date.now().toString(36)}`;
}

function defaultModel(vendor: DesktopPresetVendor): string {
  return vendor === "codex" ? "gpt-5.6-sol" : "sonnet";
}

export function PresetsBar(props: PresetsBarProps) {
  const [name, setName] = useState("");
  const [vendor, setVendor] =
    useState<DesktopPresetVendor>("claude-code");
  const [model, setModel] = useState(defaultModel("claude-code"));
  const [effort, setEffort] = useState<DesktopPresetEffort>("medium");
  const [permission, setPermission] =
    useState<DesktopPresetPermission>("default");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savePreset = async () => {
    const candidate = normalizeDesktopPresets([
      {
        id: nextPresetId(name, props.presets),
        name,
        vendor,
        model,
        effort,
        permission,
      },
    ])[0];
    if (!candidate) {
      setError("Use a short name and a valid model, effort, and permission.");
      return;
    }
    if (props.presets.length >= MAX_DESKTOP_PRESETS) {
      setError(`Presets are limited to ${MAX_DESKTOP_PRESETS}.`);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await props.onSave([...props.presets, candidate]);
      setName("");
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Could not save preset."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Dispatch presets" className="presets-bar">
      <div className="preset-strip">
        {props.presets.length === 0 ? (
          <span className="preset-empty">No presets</span>
        ) : (
          props.presets.map((preset) => {
            const applying = props.applyingPresetId === preset.id;
            return (
              <button
                aria-label={`Apply ${preset.name} preset: ${preset.vendor}, ${preset.model}, ${preset.effort} effort, ${preset.permission} permission`}
                aria-pressed={props.activePresetId === preset.id}
                className="preset-chip"
                disabled={props.disabled || Boolean(props.applyingPresetId)}
                key={preset.id}
                onClick={() => void props.onApply(preset.id)}
                title={`${preset.vendor} · ${preset.model} · ${preset.effort} · ${preset.permission}`}
                type="button"
              >
                <VendorIcon size={11} vendor={preset.vendor} />
                <span>{applying ? "…" : preset.name}</span>
              </button>
            );
          })
        )}
        <details className="preset-editor">
          <summary>Add</summary>
          <div className="preset-editor-grid">
            <label>
              Name
              <input
                maxLength={40}
                onChange={(event) => setName(event.target.value)}
                placeholder="Review"
                value={name}
              />
            </label>
            <label>
              Vendor
              <select
                onChange={(event) => {
                  const next = event.target.value as DesktopPresetVendor;
                  setVendor(next);
                  setModel(defaultModel(next));
                }}
                value={vendor}
              >
                {DESKTOP_PRESET_VENDORS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <input
                maxLength={200}
                onChange={(event) => setModel(event.target.value)}
                value={model}
              />
            </label>
            <label>
              Effort
              <select
                onChange={(event) =>
                  setEffort(event.target.value as DesktopPresetEffort)
                }
                value={effort}
              >
                {DESKTOP_PRESET_EFFORTS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Permission
              <select
                onChange={(event) =>
                  setPermission(event.target.value as DesktopPresetPermission)
                }
                value={permission}
              >
                {DESKTOP_PRESET_PERMISSIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary-btn"
              disabled={saving}
              onClick={() => void savePreset()}
              type="button"
            >
              {saving ? "Saving…" : "Save preset"}
            </button>
          </div>
          {error ? <span role="alert">{error}</span> : null}
        </details>
      </div>
      {props.status ? (
        <span className="preset-status" role="status">
          {props.status}
        </span>
      ) : null}
    </section>
  );
}
