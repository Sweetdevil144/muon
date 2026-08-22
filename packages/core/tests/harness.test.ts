import { describe, expect, it } from "vitest";
import {
  harnessConfigSchema,
  laneProfileSchema,
  mcpServerConfigSchema,
} from "@muon/protocol";
import {
  applyHarnessToProfile,
  assertHarnessRequirements,
  mergeHarnessOverlay,
  DEFAULT_HARNESSES,
} from "../src/harness.js";

describe("mergeHarnessOverlay", () => {
  it("lets overlay fields win while preserving unset profile fields", () => {
    const profile = laneProfileSchema.parse({
      model: "opus",
      permissionMode: "default",
      allowedTools: ["Read"],
      env: { A: "1", B: "1" },
      extraArgs: ["--verbose"],
    });

    const merged = mergeHarnessOverlay(profile, {
      permissionMode: "strict",
      sandbox: "read-only",
      env: { B: "2" },
      extraArgs: ["--max-turns", "3"],
    });

    expect(merged.model).toBe("opus");
    expect(merged.permissionMode).toBe("strict");
    expect(merged.sandbox).toBe("read-only");
    expect(merged.allowedTools).toEqual(["Read"]);
    expect(merged.env).toEqual({ A: "1", B: "2" });
    expect(merged.extraArgs).toEqual(["--verbose", "--max-turns", "3"]);
  });

  it("merges mcpServers by name so the injected muon server survives", () => {
    const profile = laneProfileSchema.parse({
      mcpServers: [
        { name: "muon", command: "muon-mcp" },
        { name: "docs", command: "docs-mcp" },
      ],
    });

    const merged = mergeHarnessOverlay(profile, {
      mcpServers: [
        mcpServerConfigSchema.parse({ name: "docs", command: "docs-mcp-v2" }),
      ],
    });

    const names = merged.mcpServers.map((server) => server.name).sort();
    expect(names).toEqual(["docs", "muon"]);
    expect(
      merged.mcpServers.find((server) => server.name === "docs")?.command
    ).toBe("docs-mcp-v2");
  });
});

describe("applyHarnessToProfile", () => {
  it("unions preauthorizedTools into allowedTools (the only pre-auth path)", () => {
    const harness = harnessConfigSchema.parse({
      profileOverlay: { sandbox: "workspace-write" },
      preauthorizedTools: ["Bash(npm test)", "Read"],
    });
    const profile = laneProfileSchema.parse({ allowedTools: ["Read"] });

    const merged = applyHarnessToProfile(profile, harness);
    expect(merged.allowedTools.sort()).toEqual(["Bash(npm test)", "Read"]);
    expect(merged.sandbox).toBe("workspace-write");
  });

  it("narrows read-only profiles across lanes that lack a native sandbox flag", () => {
    const harness = harnessConfigSchema.parse({
      profileOverlay: { sandbox: "read-only" },
      preauthorizedTools: ["Bash", "Read"],
    });
    const profile = laneProfileSchema.parse({
      allowedTools: ["Write", "Glob"],
      deniedTools: ["WebFetch"],
    });

    const merged = applyHarnessToProfile(profile, harness);
    expect(merged.allowedTools).toEqual(["Read"]);
    expect(merged.deniedTools).toEqual(
      expect.arrayContaining([
        "Bash",
        "Shell",
        "Write",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "apply_patch",
      ])
    );
  });
});

describe("assertHarnessRequirements", () => {
  it("fails fast when a worktree-requiring harness runs without one", () => {
    const harness = harnessConfigSchema.parse({
      requires: { interactive: false, worktree: true },
    });
    expect(() =>
      assertHarnessRequirements(harness, {
        laneKey: "codex",
        interactiveAvailable: false,
        worktree: false,
      })
    ).toThrow(/--worktree/);
    expect(() =>
      assertHarnessRequirements(harness, {
        laneKey: "codex",
        interactiveAvailable: false,
        worktree: true,
      })
    ).not.toThrow();
  });

  it("honors lane-specific harnesses and interactive requirements honestly", () => {
    const laneSpecific = harnessConfigSchema.parse({ laneKey: "codex" });
    expect(() =>
      assertHarnessRequirements(laneSpecific, {
        laneKey: "cursor",
        interactiveAvailable: false,
        worktree: false,
      })
    ).toThrow(/lane-specific/);

    const interactive = harnessConfigSchema.parse({
      requires: { interactive: true, worktree: false },
    });
    expect(() =>
      assertHarnessRequirements(interactive, {
        laneKey: "cursor",
        interactiveAvailable: false,
        worktree: false,
      })
    ).toThrow(/interactive/);
  });
});

/**
 * WAVE 1B — the `solo` posture. Everything else in the library is
 * worker-shaped (a dispatched child in a worktree); nothing described the case
 * measured as most common and most expensive: one operator, one module, one
 * instruction. These pin the two properties that make it a POSTURE rather
 * than a permission change.
 */
describe("the solo harness", () => {
  const solo = DEFAULT_HARNESSES.find((h) => h.key === "solo");
  const implement = DEFAULT_HARNESSES.find((h) => h.key === "implement");

  it("is seeded, so the runner accepts the key", () => {
    expect(solo, "solo harness is seeded").toBeTruthy();
    expect(solo!.name).toBe("Solo");
  });

  it("does NOT loosen governance — same permission posture as implement", () => {
    expect(solo!.config.profileOverlay).toEqual(implement!.config.profileOverlay);
    // The preflight pair is still mandatory: a solo edit is governed no more
    // loosely than a dispatched one.
    expect(solo!.config.requires?.tools).toContain("preflight_edit");
    expect(solo!.config.requires?.tools).toContain("memory_preedit");
  });

  it("changes SCOPE: no worktree, and no repo-wide check", () => {
    expect(solo!.config.requires?.worktree).toBe(false);
    // implement's repo-wide `npm test` is the wrong (and slowest) success
    // signal for a one-function edit; an empty list falls through to the
    // derived per-package checks.
    expect(solo!.config.checks ?? []).toHaveLength(0);
    expect(implement!.config.requires?.worktree).toBe(true);
  });
});
