import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  FULL_AUTO_SELECTABLE_VENDORS,
  isGlobalStandingConsent,
  loadSettings,
  normalizeFullAutoVendors,
  saveSettings,
  toRendererSettings,
} from "../src/lib/settings.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("fullAuto setting", () => {
  it("is OFF by default", () => {
    expect(DEFAULT_SETTINGS.fullAuto).toBe(false); // RED: property missing
  });
  it("round-trips through persist + load", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "muon-fa-"));
    saveSettings(dir, {
      ...DEFAULT_SETTINGS,
      fullAuto: true,
      fullAutoVendors: [...FULL_AUTO_SELECTABLE_VENDORS],
    });
    const loaded = loadSettings(dir);
    expect(loaded.fullAuto).toBe(true);
    expect(loaded.fullAutoVendors).toEqual([...FULL_AUTO_SELECTABLE_VENDORS]);
  });
  it("migrates a legacy settings.json (boolean only) to every lane", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "muon-fa-legacy-"));
    // A file written by a pre-vendor-scope build: fullAuto exists, no vendor list.
    writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ fullAuto: true }),
      { mode: 0o600 }
    );
    const loaded = loadSettings(dir);
    expect(loaded.fullAutoVendors).toEqual([...FULL_AUTO_SELECTABLE_VENDORS]);
    expect(loaded.fullAuto).toBe(true);
  });
  it("the boolean is DERIVED from the vendor list, so the pair cannot disagree", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "muon-fa-derive-"));
    // A hand-edited contradictory pair: explicit empty list wins over the flag.
    writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ fullAuto: true, fullAutoVendors: [] }),
      { mode: 0o600 }
    );
    const loaded = loadSettings(dir);
    expect(loaded.fullAutoVendors).toEqual([]);
    expect(loaded.fullAuto).toBe(false);
  });
  it("drops unknown vendor ids and keeps registry order", () => {
    expect(
      normalizeFullAutoVendors(["evil", "codex", "claude-code", "codex"], false)
    ).toEqual(
      FULL_AUTO_SELECTABLE_VENDORS.filter(
        (id) => id === "claude-code" || id === "codex"
      )
    );
  });
  it("is projected to the renderer (indicator can read it)", () => {
    expect(
      toRendererSettings({ ...DEFAULT_SETTINGS, fullAuto: true }, undefined)
        .fullAuto
    ).toBe(true);
  });
  it("OFF projection keeps fullAuto false alongside additive non-secret settings", () => {
    const r = toRendererSettings(DEFAULT_SETTINGS, undefined);
    expect(r).toEqual({
      apiBase: DEFAULT_SETTINGS.apiBase,
      apiTokenSet: false,
      autoUpdate: false,
      autoContinue: true,
      fullAuto: false,
      fullAutoVendors: [],
      portPreviewEnabled: false,
      telemetryEnabled: false,
      presets: DEFAULT_SETTINGS.presets,
      crew: DEFAULT_SETTINGS.crew,
    });
  });
});

// The GLOBAL coordinate must be ALL lanes, not any. Three consumers read it as
// an unscoped machine-wide fact — the standing-approver lease, MUON_FULL_AUTO
// in every worker preamble, and the schedule executor's canClaim — and under a
// subset each of them lies. A coordinator on an unselected lane would skip its
// fast-deny, file an approval nothing grants, and block for the 300s timeout.
describe("isGlobalStandingConsent", () => {
  it("is true only when EVERY selectable lane is selected", () => {
    expect(isGlobalStandingConsent([...FULL_AUTO_SELECTABLE_VENDORS])).toBe(true);
  });

  it("is FALSE for a subset — the fail-closed direction", () => {
    const subset = FULL_AUTO_SELECTABLE_VENDORS.slice(0, 1);
    expect(subset.length).toBeGreaterThan(0);
    expect(isGlobalStandingConsent(subset)).toBe(false);
  });

  it("is false for no selection at all", () => {
    expect(isGlobalStandingConsent([])).toBe(false);
  });

  it("loadSettings derives it, so the pair can never disagree", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "muon-fa-global-"));
    writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({
        fullAuto: true, // a hand-edited lie
        fullAutoVendors: FULL_AUTO_SELECTABLE_VENDORS.slice(0, 1),
      }),
      { mode: 0o600 }
    );
    const loaded = loadSettings(dir);
    expect(loaded.fullAutoVendors).toHaveLength(1);
    expect(loaded.fullAuto).toBe(false);
  });
});
