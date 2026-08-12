import { describe, expect, it } from "vitest";
import { laneProfileSchema } from "@muon/client";
import {
  DEFAULT_DESKTOP_PRESETS,
  normalizeDesktopPresets,
  type DesktopPreset,
} from "../src/lib/presets.js";
import { applyDesktopPresetToProfile } from "../src/lib/preset-profile.js";

const codexPreset: DesktopPreset = {
  id: "review",
  name: "Review",
  vendor: "codex",
  model: "gpt-5-codex",
  effort: "high",
  permission: "strict",
};

describe("desktop presets", () => {
  it("projects settings onto the complete allowlist and rejects bypass modes", () => {
    expect(
      normalizeDesktopPresets([
        {
          ...codexPreset,
          allowedTools: ["*"],
          mcpServers: [{ name: "evil", command: "sh" }],
          sandbox: "full-access",
          token: "secret",
        },
      ])
    ).toEqual([codexPreset]);

    expect(
      normalizeDesktopPresets([
        {
          ...codexPreset,
          id: "bypass",
          permission: "full-auto",
        },
      ])
    ).toEqual([]);
  });

  it("changes only model, fixed effort, and non-bypass permission fields", () => {
    const base = laneProfileSchema.parse({
      model: "o3",
      permissionMode: "default",
      sandbox: "workspace-write",
      mcpServers: [
        {
          name: "muon",
          command: "muon-mcp",
          args: [],
          env: { MUON_MCP_MODE: "worker" },
        },
      ],
      allowedTools: ["Read", "Bash"],
      deniedTools: ["WebFetch"],
      contextFiles: ["AGENTS.md"],
      addDirs: ["/repo"],
      env: { SAFE: "1" },
      extraArgs: ["--quiet"],
      rawConfig: { model_verbosity: "low", model_reasoning_effort: "medium" },
    });

    const applied = applyDesktopPresetToProfile(base, codexPreset);

    expect(applied).toMatchObject({
      model: "gpt-5-codex",
      permissionMode: "strict",
      sandbox: "workspace-write",
      allowedTools: ["Read", "Bash"],
      deniedTools: ["WebFetch"],
      contextFiles: ["AGENTS.md"],
      addDirs: ["/repo"],
      env: { SAFE: "1" },
      extraArgs: ["--quiet"],
      rawConfig: {
        model_verbosity: "low",
        model_reasoning_effort: "high",
      },
    });
    expect(applied.mcpServers).toEqual(base.mcpServers);
  });

  it("replaces the prior fixed effort flag instead of accumulating argv", () => {
    const base = laneProfileSchema.parse({
      extraArgs: ["--verbose", "--effort", "low", "--color"],
      allowedTools: ["Read"],
    });
    const applied = applyDesktopPresetToProfile(base, {
      id: "careful",
      name: "Careful",
      vendor: "claude-code",
      model: "opus",
      effort: "high",
      permission: "strict",
    });

    expect(applied.extraArgs).toEqual([
      "--verbose",
      "--color",
      "--effort",
      "high",
    ]);
    expect(applied.allowedTools).toEqual(["Read"]);
  });

  it("keeps every shipped preset inside the same non-authority profile surface", () => {
    const base = laneProfileSchema.parse({
      sandbox: "workspace-write",
      mcpServers: [
        {
          name: "muon",
          command: "muon-mcp",
          args: [],
          env: { MUON_MCP_MODE: "worker" },
        },
      ],
      allowedTools: ["Read"],
      deniedTools: ["WebFetch"],
      env: { SAFE: "1" },
    });

    for (const preset of DEFAULT_DESKTOP_PRESETS) {
      const applied = applyDesktopPresetToProfile(base, preset);
      expect(applied.sandbox).toBe(base.sandbox);
      expect(applied.mcpServers).toEqual(base.mcpServers);
      expect(applied.allowedTools).toEqual(base.allowedTools);
      expect(applied.deniedTools).toEqual(base.deniedTools);
      expect(applied.env).toEqual(base.env);
      expect(applied.permissionMode).not.toBe("full-auto");
    }
  });
});
