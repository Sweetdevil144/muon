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
