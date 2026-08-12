import { describe, expect, it } from "vitest";
import {
  AGENT_ROLES,
  GOVERNED_MCP_SERVER_NAME,
  ROLE_SPECS,
  RoleAuthorityError,
  assertProfileMatchesRole,
  isReadOnlyRole,
  isWriteClassTool,
  narrowProfileForRole,
  type AgentRole,
} from "../src/agent-role.js";
import {
  laneProfileSchema,
  type LaneProfile,
  type PermissionMode,
  type SandboxMode,
} from "../src/lane-profile.js";

/**
 * Local copies of the module's private orderings. A contract test must not
 * import the thing it is checking the ordering OF — if the ranks are ever
 * reordered in the source, these fixtures are what notices.
 */
const PERMISSION_RANK: Record<PermissionMode, number> = {
  strict: 0,
  default: 1,
  "auto-edits": 2,
  "full-auto": 3,
};
const SANDBOX_RANK: Record<SandboxMode, number> = {
  "read-only": 0,
  "workspace-write": 1,
  "full-access": 2,
};

const READ_ONLY_ROLES = AGENT_ROLES.filter(isReadOnlyRole);

/**
 * The adversary profile: maximum authority routed through EVERY passthrough
 * surface at once — typed core, both `extraArgs` spellings, and a dotted
 * `rawConfig` key. Anything a role narrowing misses here reaches the vendor.
 */
function widestProfile(): LaneProfile {
  return laneProfileSchema.parse({
    model: "vendor-frontier",
    permissionMode: "full-auto",
    sandbox: "full-access",
    mcpServers: [
      { name: "muon", command: "node", args: ["mcp.js"], env: { A: "1" } },
    ],
    contextFiles: ["docs/spec.md"],
    addDirs: ["/repo/extra"],
    allowedTools: [
      "Read",
      "Grep",
      "Write",
      "Edit(src/**)",
      "mcp__fs__write_file",
      "mcp__muon__preflight_edit",
    ],
    deniedTools: ["WebFetch"],
    env: { MUON_TEST: "1" },
    extraArgs: [
      "--model=vendor-frontier",
      "--sandbox",
      "danger-full-access",
      "--permission-mode=full-auto",
      "--force",
    ],
    rawConfig: {
      "tools.sandbox_mode": "danger-full-access",
      approval_policy: "never",
      "features.multi_agent": false,
    },
  });
}

/** Every re-widening vector, each isolated in ONE field. */
const WIDENING_VECTORS: readonly {
  name: string;
  patch: Partial<LaneProfile>;
  /** Substring the violation report must name, so the operator can act. */
  reported: string;
}[] = [
  {
    name: "allowedTools carries a native write verb",
    patch: { allowedTools: ["Read", "Write"] },
    reported: "write-class tools allowed",
  },
  {
    name: "allowedTools carries a tool-specifier write verb",
    patch: { allowedTools: ["Edit(src/**)"] },
    reported: "write-class tools allowed",
  },
  {
    name: "allowedTools carries an MCP-namespaced write verb",
    patch: { allowedTools: ["mcp__fs__write_file"] },
    reported: "write-class tools allowed",
  },
  {
    name: "extraArgs re-opens the sandbox in `--flag value` form",
    patch: { extraArgs: ["--sandbox", "danger-full-access"] },
    reported: "authority-widening args",
  },
  {
    name: "extraArgs re-opens the sandbox in `--flag=value` form",
    patch: { extraArgs: ["--sandbox=danger-full-access"] },
    reported: "authority-widening args",
  },
  {
    name: "extraArgs carries a bare bypass flag",
    patch: { extraArgs: ["--dangerously-skip-permissions"] },
    reported: "authority-widening args",
  },
  {
    name: "rawConfig carries a dotted vendor-native sandbox key",
    patch: { rawConfig: { "tools.sandbox_mode": "danger-full-access" } },
    reported: "authority-widening config",
  },
  {
    name: "rawConfig carries a bare approval-policy key",
    patch: { rawConfig: { approval_policy: "never" } },
    reported: "authority-widening config",
  },
];

describe("narrowProfileForRole is MONOTONE", () => {
  for (const role of AGENT_ROLES) {
    it(`only removes authority for '${role}'`, () => {
      const input = widestProfile();
      const output = narrowProfileForRole(input, role);

      // Never ADDS an allowed tool.
      for (const tool of output.allowedTools) {
        expect(input.allowedTools).toContain(tool);
      }
      // Only GROWS deniedTools.
      for (const tool of input.deniedTools) {
        expect(output.deniedTools).toContain(tool);
      }
      // Never widens either clamped axis…
      expect(PERMISSION_RANK[output.permissionMode!]).toBeLessThanOrEqual(
        PERMISSION_RANK[input.permissionMode!]
      );
      expect(SANDBOX_RANK[output.sandbox!]).toBeLessThanOrEqual(
        SANDBOX_RANK[input.sandbox!]
      );
      // …and never past the role's own declared ceiling.
      expect(PERMISSION_RANK[output.permissionMode!]).toBeLessThanOrEqual(
        PERMISSION_RANK[ROLE_SPECS[role].maxPermissionMode]
      );
      expect(SANDBOX_RANK[output.sandbox!]).toBeLessThanOrEqual(
        SANDBOX_RANK[ROLE_SPECS[role].maxSandbox]
      );
      // Passthrough surfaces never gain entries either.
      for (const arg of output.extraArgs) {
        expect(input.extraArgs).toContain(arg);
      }
      for (const key of Object.keys(output.rawConfig)) {
        expect(Object.keys(input.rawConfig)).toContain(key);
      }
    });
  }

  it("holds for EVERY starting permission mode and sandbox, not just the widest", () => {
    const modes: PermissionMode[] = [
      "strict",
      "default",
      "auto-edits",
      "full-auto",
    ];
    const sandboxes: SandboxMode[] = [
      "read-only",
      "workspace-write",
      "full-access",
    ];
    for (const role of AGENT_ROLES) {
      for (const permissionMode of modes) {
        for (const sandbox of sandboxes) {
          const input = laneProfileSchema.parse({ permissionMode, sandbox });
          const output = narrowProfileForRole(input, role);
          expect(PERMISSION_RANK[output.permissionMode!]).toBeLessThanOrEqual(
            PERMISSION_RANK[permissionMode]
          );
          expect(SANDBOX_RANK[output.sandbox!]).toBeLessThanOrEqual(
            SANDBOX_RANK[sandbox]
          );
        }
      }
    }
  });

  it("leaves an UNSET axis unset rather than adopting the role ceiling", () => {
    // The one place a "narrowing" could accidentally GRANT authority. An unset
    // axis means "whatever the vendor/harness defaults to". Resolving it to the
    // role ceiling would hand `implementer` an explicit `auto-edits` the lane
    // profile never carried — a widening performed by the narrowing function
    // itself. So unset stays unset...
    const unset = laneProfileSchema.parse({});
    expect(narrowProfileForRole(unset, "scout").permissionMode).toBeUndefined();
    expect(
      narrowProfileForRole(unset, "implementer").permissionMode
    ).toBeUndefined();
    expect(narrowProfileForRole(unset, "implementer").sandbox).toBeUndefined();

    // ...with ONE sound exception: a read-only role forces the sandbox to
    // `read-only`, the MINIMUM of the lattice. Forcing the tightest possible
    // value can only narrow, and it is the enforcement that makes a reviewer a
    // reviewer instead of a writer wearing a label.
    for (const role of AGENT_ROLES.filter((r) => isReadOnlyRole(r))) {
      expect(narrowProfileForRole(unset, role).sandbox).toBe("read-only");
    }
  });
});

describe("narrowProfileForRole is IDEMPOTENT", () => {
  for (const role of AGENT_ROLES) {
    it(`narrow(narrow(p, '${role}'), '${role}') === narrow(p, '${role}')`, () => {
      const once = narrowProfileForRole(widestProfile(), role);
      const twice = narrowProfileForRole(once, role);
      expect(twice).toEqual(once);
    });
  }
});

describe("narrowProfileForRole is TOTAL over every passthrough surface", () => {
  for (const role of READ_ONLY_ROLES) {
    for (const vector of WIDENING_VECTORS) {
      it(`neutralizes '${vector.name}' for '${role}'`, () => {
        // Each vector carries write authority in exactly ONE field, so a
        // narrowing that covers only the typed core fails here rather than
        // hiding behind a sibling field that happens to be covered.
        const input = laneProfileSchema.parse({
          permissionMode: "full-auto",
          sandbox: "full-access",
          ...vector.patch,
        });
        const output = narrowProfileForRole(input, role);

        expect(output.allowedTools.filter(isWriteClassTool)).toEqual([]);
        expect(output.sandbox).toBe("read-only");
        expect(PERMISSION_RANK[output.permissionMode!]).toBeLessThanOrEqual(
          PERMISSION_RANK[ROLE_SPECS[role].maxPermissionMode]
        );
        // The narrowed profile is, by definition, launchable as this role.
        expect(() => assertProfileMatchesRole(output, role)).not.toThrow();
      });
    }
  }

  it("drops the VALUE token of a `--flag value` pair, never orphaning it", () => {
    const input = laneProfileSchema.parse({
      extraArgs: [
        "--sandbox",
        "danger-full-access",
        "--model",
        "vendor-frontier",
      ],
    });
    // The sandbox value must not survive as a bare positional the vendor
    // would then reinterpret; the unrelated `--model` pair is untouched.
    expect(narrowProfileForRole(input, "reviewer").extraArgs).toEqual([
      "--model",
      "vendor-frontier",
    ]);
  });

  it("keeps a read-only role's non-authority passthrough intact", () => {
    const output = narrowProfileForRole(widestProfile(), "reviewer");
    expect(output.extraArgs).toEqual(["--model=vendor-frontier"]);
    expect(output.rawConfig).toEqual({ "features.multi_agent": false });
    // Governed MUON MCP tools are not native writes and must survive, or a
    // reviewer would lose the very tools it reviews with.
    expect(output.allowedTools).toEqual([
      "Read",
      "Grep",
      "mcp__muon__preflight_edit",
    ]);
    // Model, context, and env are not authority and are carried through.
    expect(output.model).toBe("vendor-frontier");
    expect(output.contextFiles).toEqual(["docs/spec.md"]);
    expect(output.env).toEqual({ MUON_TEST: "1" });
  });
});

describe("assertProfileMatchesRole fails closed", () => {
  it("passes for a correctly narrowed profile in every role", () => {
    for (const role of AGENT_ROLES) {
      const narrowed = narrowProfileForRole(widestProfile(), role);
      expect(() => assertProfileMatchesRole(narrowed, role)).not.toThrow();
    }
  });

  for (const vector of WIDENING_VECTORS) {
    it(`throws RoleAuthorityError when '${vector.name}' is re-added after narrowing`, () => {
      // The exact defeat this assertion exists for: the narrowing ran, and a
      // LATER merge (harness overlay, preset, vendor-native fragment) spread a
      // wider source back over it. Every vector must be caught independently.
      const narrowed = narrowProfileForRole(widestProfile(), "reviewer");
      const rewidened = laneProfileSchema.parse({
        ...narrowed,
        ...vector.patch,
      });
      let thrown: unknown;
      try {
        assertProfileMatchesRole(rewidened, "reviewer");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RoleAuthorityError);
      const failure = thrown as RoleAuthorityError;
      expect(failure.role).toBe("reviewer");
      expect(failure.violations.join("; ")).toContain(vector.reported);
      // The message is operator-facing: it names the role and the violation.
      expect(failure.message).toContain("reviewer");
      expect(failure.message).toContain(vector.reported);
    });
  }

  it("catches a re-widened permission mode and sandbox", () => {
    const narrowed = narrowProfileForRole(widestProfile(), "qa");
    expect(() =>
      assertProfileMatchesRole(
        { ...narrowed, permissionMode: "full-auto" },
        "qa"
      )
    ).toThrow(RoleAuthorityError);
    expect(() =>
      assertProfileMatchesRole({ ...narrowed, sandbox: "full-access" }, "qa")
    ).toThrow(RoleAuthorityError);
  });

  it("reports EVERY violation at once, not just the first", () => {
    const narrowed = narrowProfileForRole(widestProfile(), "architect");
    let thrown: unknown;
    try {
      assertProfileMatchesRole(
        laneProfileSchema.parse({
          ...narrowed,
          permissionMode: "full-auto",
          sandbox: "full-access",
          allowedTools: ["Write"],
          extraArgs: ["--force"],
          rawConfig: { "tools.sandbox_mode": "danger-full-access" },
        }),
        "architect"
      );
    } catch (error) {
      thrown = error;
    }
    const failure = thrown as RoleAuthorityError;
    expect(failure.violations).toHaveLength(5);
  });

  it("does not constrain tools for a write-authority role", () => {
    // A role narrows; it never invents a constraint the spec did not declare.
    const writing = laneProfileSchema.parse({
      permissionMode: "auto-edits",
      sandbox: "workspace-write",
      allowedTools: ["Write", "Edit"],
      extraArgs: ["--force"],
    });
    expect(() =>
      assertProfileMatchesRole(writing, "implementer")
    ).not.toThrow();
  });
});

describe("isWriteClassTool", () => {
  it("flags the specifier form", () => {
    expect(isWriteClassTool("Write(src/**)")).toBe(true);
    expect(isWriteClassTool("Edit(packages/core/**)")).toBe(true);
  });

  it("flags the MCP-namespaced form", () => {
    expect(isWriteClassTool("mcp__fs__write_file")).toBe(true);
    expect(isWriteClassTool("mcp__filesystem__edit_file")).toBe(true);
    expect(isWriteClassTool("mcp__editor__str_replace_editor")).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isWriteClassTool("WRITE")).toBe(true);
    expect(isWriteClassTool("MultiEdit")).toBe(true);
    expect(isWriteClassTool("  NotebookEdit  ")).toBe(true);
    expect(isWriteClassTool("APPLY_PATCH")).toBe(true);
    expect(isWriteClassTool("mcp__FS__WRITE_FILE")).toBe(true);
  });

  it("does NOT flag read tools", () => {
    for (const tool of [
      "Read",
      "Grep",
      "Glob",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
      "Read(src/**)",
      "mcp__muon__memory_search",
      "mcp__muon__preflight_edit",
      "mcp__muon__review_diff",
      "mcp__fs__read_file",
      "",
      "   ",
    ]) {
      expect(isWriteClassTool(tool)).toBe(false);
    }
  });

  it("does not prefix-match: a longer name that merely starts with a write verb is not write-class", () => {
    // Exactness is the point — a prefix rule would deny `WriteupReader`, and an
    // auditor could not tell which rule fired.
    expect(isWriteClassTool("Writeup")).toBe(false);
    expect(isWriteClassTool("Editorial")).toBe(false);
  });
});

describe("ROLE_SPECS", () => {
  it("declares every read-only role as write-denied, read-only sandboxed", () => {
    for (const role of READ_ONLY_ROLES) {
      const spec = ROLE_SPECS[role];
      expect(spec.allowsWriteTools).toBe(false);
      expect(spec.maxSandbox).toBe("read-only");
      expect(
        PERMISSION_RANK[spec.maxPermissionMode]
      ).toBeLessThanOrEqual(PERMISSION_RANK.default);
    }
  });

  it("covers exactly the four read-only roles the runner enforces", () => {
    expect([...READ_ONLY_ROLES].sort()).toEqual([
      "architect",
      "qa",
      "reviewer",
      "scout",
    ] satisfies AgentRole[]);
  });
});

/**
 * Regression suite for the three defeats an adversarial review landed on the
 * narrowing. Each `it` reproduces the reviewer's exact vector.
 */
describe("narrowProfileForRole covers every authority CHANNEL, not just every field name", () => {
  it("strips codex's `-c key=value` config channel, which is rawConfig by another spelling", () => {
    // The defeat: rawConfig was filtered by key while `-c` was waved through,
    // so `sandbox_mode="read-only"` and `sandbox_mode="danger-full-access"`
    // both reached one reviewer's argv — and the launch assertion passed.
    const profile = laneProfileSchema.parse({
      extraArgs: [
        "-c",
        'sandbox_mode="danger-full-access"',
        "--config",
        "approval_policy=never",
        "-c=permission_mode=bypassPermissions",
      ],
    });
    for (const role of READ_ONLY_ROLES) {
      const narrowed = narrowProfileForRole(profile, role);
      expect(narrowed.extraArgs.join(" ")).not.toMatch(/danger-full-access/);
      expect(narrowed.extraArgs.join(" ")).not.toMatch(/approval_policy/);
      expect(narrowed.extraArgs.join(" ")).not.toMatch(/permission_mode/);
      expect(() => assertProfileMatchesRole(profile, role)).toThrow(
        RoleAuthorityError
      );
      expect(() => assertProfileMatchesRole(narrowed, role)).not.toThrow();
    }
  });

  it("keeps a benign `-c` config value — the channel is filtered by key, not banned", () => {
    // The Ollama lane pins `-c model_reasoning_effort=none`; a blanket ban on
    // `-c` would silently break local models for every read-only role.
    const profile = laneProfileSchema.parse({
      extraArgs: ["-c", "model_reasoning_effort=none"],
    });
    expect(narrowProfileForRole(profile, "scout").extraArgs).toEqual([
      "-c",
      "model_reasoning_effort=none",
    ]);
  });

  it("judges value-flags by VALUE, so a TIGHTENING invocation survives", () => {
    // The inversion: dropping `--permission-mode` by name removed Claude's
    // `plan` (its tightest mode), letting the compiler emit the role ceiling
    // instead — naming a job `reviewer` made it LESS restricted than no role.
    const tightening = laneProfileSchema.parse({
      extraArgs: [
        "--permission-mode",
        "plan",
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "untrusted",
      ],
    });
    for (const role of READ_ONLY_ROLES) {
      expect(narrowProfileForRole(tightening, role).extraArgs).toEqual(
        tightening.extraArgs
      );
      expect(() => assertProfileMatchesRole(tightening, role)).not.toThrow();
    }

    const widening = laneProfileSchema.parse({
      extraArgs: ["--sandbox", "danger-full-access", "--permission-mode=acceptEdits"],
    });
    for (const role of READ_ONLY_ROLES) {
      expect(narrowProfileForRole(widening, role).extraArgs).toEqual([]);
      expect(() => assertProfileMatchesRole(widening, role)).toThrow(
        RoleAuthorityError
      );
    }
  });

  it("treats an UNRECOGNIZED value for a directional flag as widening (fails closed)", () => {
    const profile = laneProfileSchema.parse({
      extraArgs: ["--sandbox", "some-future-mode"],
    });
    expect(narrowProfileForRole(profile, "reviewer").extraArgs).toEqual([]);
    expect(() => assertProfileMatchesRole(profile, "reviewer")).toThrow(
      RoleAuthorityError
    );
  });

  it("drops non-governed MCP servers, which the sandbox does not reach", () => {
    // codex reports allowedTools/deniedTools as UNSUPPORTED and its sandbox
    // governs its own shell/patch tools, NOT a stdio MCP server it spawns — so
    // a filesystem MCP server was a read-only reviewer's unbounded write path.
    const profile = laneProfileSchema.parse({
      mcpServers: [
        { name: "fs", command: "npx", args: [], env: {} },
        { name: GOVERNED_MCP_SERVER_NAME, command: "node", args: [], env: {} },
      ],
    });
    for (const role of READ_ONLY_ROLES) {
      expect(
        narrowProfileForRole(profile, role).mcpServers.map((s) => s.name)
      ).toEqual([GOVERNED_MCP_SERVER_NAME]);
      expect(() => assertProfileMatchesRole(profile, role)).toThrow(
        /non-governed MCP servers: fs/
      );
    }
    // A write-authority role keeps its servers.
    expect(
      narrowProfileForRole(profile, "implementer").mcpServers.map((s) => s.name)
    ).toEqual(["fs", GOVERNED_MCP_SERVER_NAME]);
  });

  it("emits deniedTools in the vendor's own casing so the argv is not inert", () => {
    // All-lowercase names produced `claude --disallowedTools write edit …`,
    // matching nothing in Claude's vocabulary (`Write`, `Edit`, `MultiEdit`).
    const denied = narrowProfileForRole(
      laneProfileSchema.parse({}),
      "reviewer"
    ).deniedTools;
    for (const canonical of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      expect(denied).toContain(canonical);
    }
    // …while matching stays case-insensitive.
    expect(isWriteClassTool("write")).toBe(true);
    expect(isWriteClassTool("WRITE")).toBe(true);
    expect(isWriteClassTool("Write(src/**)")).toBe(true);
  });
});
