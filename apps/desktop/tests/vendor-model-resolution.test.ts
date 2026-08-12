import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetVendorModelResolutions,
  resolveVendorModel,
} from "../src/lib/vendor-models.js";
import {
  compactModelLabel,
  modelDisplay,
  vendorChoiceLabel,
} from "../src/renderer/lib/model-label.js";

/**
 * "Vendor default" was a placeholder printed where a model name belongs.
 * These pin the halves of the fix: MUON asks the vendor, MUON says something
 * TRUE when the vendor does not answer, and MUON does not claim ignorance of a
 * preference the operator themselves configured.
 */

const CODEX_DOCTOR_JSON = JSON.stringify({
  checks: {
    config: {
      load: {
        details: { model: "gpt-5.6-sol", "model provider": "openai" },
      },
    },
  },
});

/**
 * A fixed, fake environment for the Claude Code settings cascade. Every test
 * that touches claude-code MUST inject `readFile`, or the resolver would read
 * the developer's real `~/.claude/settings.json` and the suite would pass or
 * fail on whatever that machine happens to have configured.
 */
const CLAUDE_ENV = {
  home: "/home/dev",
  configDir: null,
  platform: "darwin" as NodeJS.Platform,
  projectDir: "/repo",
} as const;

const MANAGED = "/Library/Application Support/ClaudeCode/managed-settings.json";
const PROJECT_LOCAL = "/repo/.claude/settings.local.json";
const PROJECT_SHARED = "/repo/.claude/settings.json";
const USER = "/home/dev/.claude/settings.json";

function enoent(file: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, open '${file}'`);
  (error as NodeJS.ErrnoException).code = "ENOENT";
  return error;
}

const absentFile = async (file: string): Promise<string> => {
  throw enoent(file);
};

/** A fake disk: only the named files exist; everything else is ENOENT. */
function fakeDisk(files: Record<string, string>) {
  return vi.fn(async (file: string) => {
    const contents = files[file];
    if (contents === undefined) throw enoent(file);
    return contents;
  });
}

beforeEach(() => {
  resetVendorModelResolutions();
});

describe("resolveVendorModel", () => {
  it("reports the model the vendor CLI itself names", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: CODEX_DOCTOR_JSON });
    const resolution = await resolveVendorModel("codex", { run });

    expect(run).toHaveBeenCalledWith("codex", ["doctor", "--json"]);
    expect(resolution).toMatchObject({
      vendor: "codex",
      model: "gpt-5.6-sol",
      state: "reported",
      probe: "codex doctor --json",
    });
  });

  it("says 'not reported' — not a guess — when the probe names no model", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ checks: {} }) });
    const resolution = await resolveVendorModel("codex", { run });

    expect(resolution.model).toBeNull();
    expect(resolution.state).toBe("not-reported");
    expect(resolution.reason).toContain("named no model");
  });

  it("keeps a failed probe as a FAILURE, with the reason, never a fallback name", async () => {
    const run = vi.fn().mockRejectedValue(new Error("codex: command not found"));
    const resolution = await resolveVendorModel("codex", { run });

    expect(resolution.model).toBeNull();
    expect(resolution.state).toBe("probe-failed");
    expect(resolution.reason).toContain("command not found");
  });

  it("states 'no probe' for a vendor MUON cannot ask, and spawns nothing", async () => {
    const run = vi.fn();
    const readFile = vi.fn();
    // claude-code is deliberately NOT here: it resolves from the operator's own
    // settings cascade, not from a subprocess. Every vendor left has neither.
    for (const vendor of ["cursor", "opencode", "fake"] as const) {
      const resolution = await resolveVendorModel(vendor, { run, readFile });
      expect(resolution.state).toBe("no-probe");
      expect(resolution.model).toBeNull();
    }
    expect(run).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("never lets one vendor's answer become another's", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: CODEX_DOCTOR_JSON });
    const claude = await resolveVendorModel("claude-code", {
      run,
      readFile: absentFile,
      ...CLAUDE_ENV,
    });
    expect(claude.model).toBeNull();
    // Codex's stdout was never offered to the Claude Code resolver at all.
    expect(run).not.toHaveBeenCalled();
  });

  it("sanitizes an untrusted model id before it reaches the UI", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        checks: {
          config: {
            load: { details: { model: "gpt<script>alert(1)</script>-5.6" } },
          },
        },
      }),
    });
    const resolution = await resolveVendorModel("codex", { run });
    expect(resolution.model).not.toContain("<");
    expect(resolution.model).not.toContain(">");
  });

  it("survives unparseable vendor output without throwing at the caller", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "not json at all" });
    await expect(resolveVendorModel("codex", { run })).resolves.toMatchObject({
      model: null,
    });
  });
});

/**
 * D1 — Claude Code's model IS knowable, because the operator set it. Reading a
 * credential would be going behind their back; reading a display preference
 * they configured, to show it back to them in their own app, is the opposite.
 * These pin BOTH halves: MUON resolves it, and MUON stays honest when there is
 * genuinely nothing configured.
 */
describe("resolveVendorModel — Claude Code settings cascade", () => {
  it("resolves the model the operator set in their user settings", async () => {
    const readFile = fakeDisk({
      [USER]: JSON.stringify({ model: "opus[1m]" }),
    });
    const resolution = await resolveVendorModel("claude-code", {
      readFile,
      ...CLAUDE_ENV,
    });

    expect(resolution).toMatchObject({
      vendor: "claude-code",
      model: "opus[1m]",
      state: "reported",
    });
    // Provenance is home-relative, so the operator recognises it as their own
    // file and no username lands in a screenshot.
    expect(resolution.probe).toBe("~/.claude/settings.json");
  });

  it("keeps the bracketed context-window variant intact", async () => {
    // `opus[1m]` sanitized down to `opus1m` would be a model that DOES NOT
    // EXIST — a silently wrong answer, which is worse than no answer.
    const readFile = fakeDisk({
      [USER]: JSON.stringify({ model: "sonnet[1m]" }),
    });
    const resolution = await resolveVendorModel("claude-code", {
      readFile,
      ...CLAUDE_ENV,
    });
    expect(resolution.model).toBe("sonnet[1m]");
  });

  it("pins the precedence: managed policy > project local > project shared > user", async () => {
    const all = {
      [MANAGED]: JSON.stringify({ model: "managed-model" }),
      [PROJECT_LOCAL]: JSON.stringify({ model: "project-local-model" }),
      [PROJECT_SHARED]: JSON.stringify({ model: "project-shared-model" }),
      [USER]: JSON.stringify({ model: "user-model" }),
    };
    const expected = [
      "managed-model",
      "project-local-model",
      "project-shared-model",
      "user-model",
    ];
    // Peel one tier off the top at a time; each time, the NEXT tier down must
    // win. That walks the whole cascade rather than spot-checking one pair.
    const tiers = [MANAGED, PROJECT_LOCAL, PROJECT_SHARED, USER];
    const disk: Record<string, string> = { ...all };
    for (let i = 0; i < tiers.length; i += 1) {
      resetVendorModelResolutions();
      const resolution = await resolveVendorModel("claude-code", {
        readFile: fakeDisk(disk),
        ...CLAUDE_ENV,
      });
      expect(resolution.model).toBe(expected[i]);
      delete disk[tiers[i]!];
    }
  });

  it("lets an admin policy outrank a model the user set for themselves", async () => {
    const readFile = fakeDisk({
      [MANAGED]: JSON.stringify({ model: "policy-pinned" }),
      [USER]: JSON.stringify({ model: "opus[1m]" }),
    });
    const resolution = await resolveVendorModel("claude-code", {
      readFile,
      ...CLAUDE_ENV,
    });
    expect(resolution.model).toBe("policy-pinned");
    expect(resolution.probe).toBe(MANAGED);
  });

  it("stays honestly not-reported when no settings file exists", async () => {
    const resolution = await resolveVendorModel("claude-code", {
      readFile: absentFile,
      ...CLAUDE_ENV,
    });
    expect(resolution.model).toBeNull();
    expect(resolution.state).toBe("not-reported");
    // It says where it looked, so "MUON doesn't know" is actionable.
    expect(resolution.reason).toContain("~/.claude/settings.json");
  });

  it("stays honestly not-reported when the key is unset, and invents no default", async () => {
    const readFile = fakeDisk({
      [USER]: JSON.stringify({ theme: "dark", includeCoAuthoredBy: false }),
    });
    const resolution = await resolveVendorModel("claude-code", {
      readFile,
      ...CLAUDE_ENV,
    });
    expect(resolution.model).toBeNull();
    expect(resolution.state).toBe("not-reported");
    // No branch may substitute an alias just because one would look plausible.
    expect(JSON.stringify(resolution)).not.toMatch(/opus|sonnet|haiku|fable/i);
  });

  it("stays honestly not-reported when a settings file is unparseable", async () => {
    const readFile = fakeDisk({ [USER]: "{ not json," });
    const resolution = await resolveVendorModel("claude-code", {
      readFile,
      ...CLAUDE_ENV,
    });
    expect(resolution.model).toBeNull();
    expect(resolution.state).toBe("not-reported");
    expect(resolution.reason).toContain("could not be read as JSON");
  });

  it("never leaks file contents through a parse error", async () => {
    // V8's own JSON.parse SyntaxError embeds a SNIPPET OF THE INPUT. Forwarding
    // that message as a `reason` would print the very secrets this resolver
    // exists to not read.
    const readFile = fakeDisk({
      [USER]: '{ "apiKeyHelper": "echo sk-super-secret-value", }',
    });
    const resolution = await resolveVendorModel("claude-code", {
      readFile,
      ...CLAUDE_ENV,
    });
    const serialized = JSON.stringify(resolution);
    expect(serialized).not.toContain("sk-super-secret-value");
    expect(serialized).not.toContain("apiKeyHelper");
  });

  it("reads ONLY the model key out of a settings file full of other things", async () => {
    const readFile = fakeDisk({
      [USER]: JSON.stringify({
        model: "opus[1m]",
        apiKeyHelper: "echo sk-super-secret-value",
        env: { ANTHROPIC_AUTH_TOKEN: "tok-do-not-read" },
        permissions: { allow: ["Bash(rm -rf /)"] },
        hooks: { PreToolUse: [{ command: "curl evil.example" }] },
      }),
    });
    const resolution = await resolveVendorModel("claude-code", {
      readFile,
      ...CLAUDE_ENV,
    });
    expect(resolution.model).toBe("opus[1m]");
    const serialized = JSON.stringify(resolution);
    for (const secret of [
      "sk-super-secret-value",
      "tok-do-not-read",
      "rm -rf",
      "evil.example",
      "apiKeyHelper",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("honours CLAUDE_CONFIG_DIR when the operator relocated their config", async () => {
    const readFile = fakeDisk({
      "/elsewhere/settings.json": JSON.stringify({ model: "relocated-model" }),
    });
    const resolution = await resolveVendorModel("claude-code", {
      readFile,
      ...CLAUDE_ENV,
      configDir: "/elsewhere",
    });
    expect(resolution.model).toBe("relocated-model");
  });

  it("reads no project tier at all when no workspace is bound", async () => {
    const readFile = fakeDisk({ [USER]: JSON.stringify({ model: "user-model" }) });
    await resolveVendorModel("claude-code", {
      readFile,
      ...CLAUDE_ENV,
      projectDir: null,
    });
    for (const call of readFile.mock.calls) {
      expect(call[0]).not.toContain("/repo/");
    }
  });

  it("caches per PROJECT, so one workspace's answer never shows under another's", async () => {
    // Real caching path (no injected source would bypass it), driven by two
    // different projectDirs. A vendor-only cache key served workspace A's model
    // under workspace B's label — the exact drift class being closed here.
    const { resolveVendorModel: resolver } = await import(
      "../src/lib/vendor-models.js"
    );
    const a = await resolver("claude-code", {
      readFile: fakeDisk({
        "/a/.claude/settings.json": JSON.stringify({ model: "model-a" }),
      }),
      ...CLAUDE_ENV,
      projectDir: "/a",
    });
    const b = await resolver("claude-code", {
      readFile: fakeDisk({
        "/b/.claude/settings.json": JSON.stringify({ model: "model-b" }),
      }),
      ...CLAUDE_ENV,
      projectDir: "/b",
    });
    expect(a.model).toBe("model-a");
    expect(b.model).toBe("model-b");
  });

  it("uses the platform's managed-policy location, not macOS's everywhere", async () => {
    const readFile = fakeDisk({
      "/etc/claude-code/managed-settings.json": JSON.stringify({
        model: "linux-policy-model",
      }),
    });
    const resolution = await resolveVendorModel("claude-code", {
      readFile,
      ...CLAUDE_ENV,
      platform: "linux",
    });
    expect(resolution.model).toBe("linux-policy-model");
  });
});

describe("modelDisplay", () => {
  it("prefers the model MUON dispatched with", () => {
    const display = modelDisplay({
      explicitModel: "gpt-5.6-terra",
      vendor: "codex",
      resolution: null,
    });
    expect(display.text).toBe("gpt-5.6-terra");
    expect(display.resolved).toBe(true);
    expect(display.title).toContain("MUON dispatched");
  });

  it("names the vendor's own reported model, with the probe as provenance", () => {
    const display = modelDisplay({
      explicitModel: null,
      vendor: "codex",
      resolution: {
        vendor: "codex",
        model: "gpt-5.6-sol",
        state: "reported",
        probe: "codex doctor --json",
      },
    });
    expect(display.text).toBe("gpt-5.6-sol · Codex default");
    expect(display.title).toContain("codex doctor --json");
    expect(compactModelLabel(display)).toBe("gpt-5.6-sol");
  });

  it("names the settings file when that is what reported the model", () => {
    const display = modelDisplay({
      vendor: "claude-code",
      resolution: {
        vendor: "claude-code",
        model: "opus[1m]",
        state: "reported",
        probe: "~/.claude/settings.json",
      },
    });
    expect(display.text).toBe("opus[1m] · Claude Code default");
    expect(display.model).toBe("opus[1m]");
    expect(display.title).toContain("~/.claude/settings.json");
  });

  it("states WHO PICKS rather than a negative, and never 'Vendor default'", () => {
    const display = modelDisplay({
      explicitModel: null,
      vendor: "claude-code",
      resolution: {
        vendor: "claude-code",
        model: null,
        state: "not-reported",
        reason: "No Claude Code settings file names a model.",
      },
    });
    expect(display.text).toBe("Claude Code picks");
    expect(display.text).not.toMatch(/vendor default/i);
    expect(display.text).not.toMatch(/not reported/i);
    expect(display.resolved).toBe(false);
    expect(display.model).toBeNull();
    // Affirmative on the surface, still fully honest on hover.
    expect(display.title).toContain("no report");
    expect(display.title).toContain("No Claude Code settings file names a model.");
  });

  it("never shows a verdict while the probe is still running", () => {
    const display = modelDisplay({
      explicitModel: null,
      vendor: "codex",
      resolution: null,
      resolving: true,
    });
    expect(display.text).toBe("Resolving…");
    expect(compactModelLabel(display)).toBe("Resolving…");
    expect(display.model).toBeNull();
  });

  it("refuses a resolution belonging to a DIFFERENT vendor", () => {
    // Two surfaces share one resolution map; this is what stops that sharing
    // from printing one vendor's model under another vendor's name.
    const display = modelDisplay({
      vendor: "claude-code",
      resolution: {
        vendor: "codex",
        model: "gpt-5.6-sol",
        state: "reported",
        probe: "codex doctor --json",
      },
    });
    expect(display.text).toBe("Claude Code picks");
    expect(display.text).not.toContain("gpt-5.6-sol");
    expect(display.resolved).toBe(false);
  });
});

/**
 * D2 — `Let Claude Code choose · Not reported by Claude Code` said the vendor's
 * name twice and buried a denial inside an affirmative choice. The row is an
 * ACTION; what it resolves to is supporting detail.
 */
describe("vendorChoiceLabel", () => {
  it("reads naturally once the model resolves", () => {
    const display = modelDisplay({
      vendor: "claude-code",
      resolution: {
        vendor: "claude-code",
        model: "opus[1m]",
        state: "reported",
        probe: "~/.claude/settings.json",
      },
    });
    expect(vendorChoiceLabel("claude-code", display)).toBe(
      "Let Claude Code choose · opus[1m]"
    );
  });

  it("does not read like an error when nothing is resolvable", () => {
    const display = modelDisplay({
      vendor: "cursor",
      resolution: {
        vendor: "cursor",
        model: null,
        state: "no-probe",
        reason: "cursor exposes no non-interactive command.",
      },
    });
    const label = vendorChoiceLabel("cursor", display);
    expect(label).toBe("Let Cursor choose");
    expect(label).not.toMatch(/not reported/i);
    expect(label).not.toMatch(/vendor default/i);
    // The vendor is named exactly once — the doubling was half the complaint.
    expect(label.match(/Cursor/g)).toHaveLength(1);
  });

  it("shows the action alone while still resolving, never a half-answer", () => {
    const display = modelDisplay({
      vendor: "claude-code",
      resolution: null,
      resolving: true,
    });
    expect(vendorChoiceLabel("claude-code", display)).toBe(
      "Let Claude Code choose"
    );
  });
});
