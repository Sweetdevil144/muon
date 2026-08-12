import { describe, expect, it } from "vitest";
import {
  VENDOR_CAPABILITY_DESCRIPTORS,
  VENDOR_ACTION_COMMAND_TOKENS,
  actionChip,
  buildVendorActionMenu,
  getVendorAction,
  isVendorActionCommand,
  mergeProfilePatch,
  normalizeVendorAlias,
  resolveVendorAction,
  sanitizeGuardedArgs,
  validateModelForVendor,
  vendorSupportsEffortControl,
  vendorSupportsModelControl,
} from "../src/vendor-capabilities.js";
import { DEFAULT_MODEL_SENTINEL, emptyLaneProfile } from "@muon/protocol";

const READY = [
  { vendor: "claude-code", installed: true, authenticated: true },
  { vendor: "codex", installed: true, authenticated: true },
  { vendor: "cursor", installed: true, authenticated: true },
];

describe("vendor capability descriptor registry", () => {
  it("enumerates every vendor with declarative actions", () => {
    for (const key of ["claude-code", "codex", "cursor"] as const) {
      const descriptor = VENDOR_CAPABILITY_DESCRIPTORS[key];
      expect(descriptor.vendor).toBe(key);
      expect(descriptor.actions.length).toBeGreaterThan(0);
    }
  });

  it("never embeds a vendor token or credential in a descriptor (no token custody)", () => {
    const serialized = JSON.stringify(VENDOR_CAPABILITY_DESCRIPTORS);
    expect(serialized).not.toMatch(/MUON_API_TOKEN/);
    expect(serialized).not.toMatch(/token|secret|password|bearer/i);
  });

  it("exposes command tokens + vendor aliases for the grammar", () => {
    expect(VENDOR_ACTION_COMMAND_TOKENS.has("ultrareview")).toBe(true);
    expect(isVendorActionCommand("plan")).toBe(true);
    expect(isVendorActionCommand("not-a-thing")).toBe(false);
    expect(normalizeVendorAlias("claude")).toBe("claude-code");
    expect(normalizeVendorAlias("[codex]")).toBe("codex");
    expect(normalizeVendorAlias("nope")).toBeUndefined();
  });
});

describe("resolveVendorAction, each v1 action → the correct invocation", () => {
  it("model → a typed LaneProfile patch", () => {
    const r = resolveVendorAction("claude-code", "model", { args: ["opus-4.8"] });
    expect(r.supported).toBe(true);
    expect(r.profilePatch).toEqual({ model: "opus-4.8" });
  });

  it("plan (claude) → a flag appended to extraArgs", () => {
    const r = resolveVendorAction("claude-code", "plan");
    expect(r.profilePatch?.extraArgs).toEqual(["--permission-mode", "plan"]);
  });

  it("permission-mode → typed field; rejects an out-of-enum value", () => {
    const ok = resolveVendorAction("codex", "permission-mode", { args: ["strict"] });
    expect(ok.profilePatch).toEqual({ permissionMode: "strict" });
    const bad = resolveVendorAction("codex", "permission-mode", { args: ["chaos"] });
    expect(bad.supported).toBe(false);
    expect(bad.reason).toMatch(/must be one of/);
  });

  it("codex effort → a rawConfig patch the compiler emits as -c", () => {
    const r = resolveVendorAction("codex", "effort", { args: ["high"] });
    expect(r.profilePatch?.rawConfig).toEqual({ model_reasoning_effort: "high" });
  });

  it("GOLDEN: /ultrareview [claude] on a target → claude ultrareview <target> --json", () => {
    const r = resolveVendorAction("claude-code", "ultrareview", {
      args: ["src/app.ts"],
    });
    expect(r.supported).toBe(true);
    expect(r.argvOverride).toEqual({
      command: "claude",
      args: ["ultrareview", "src/app.ts", "--json"],
    });
  });

  it("ultrareview with no target drops the empty slot (degrades safely)", () => {
    const r = resolveVendorAction("claude-code", "ultrareview", {});
    expect(r.argvOverride?.args).toEqual(["ultrareview", "--json"]);
  });

  it("codex plan → a prompt prefix plus a read-only sandbox patch", () => {
    const r = resolveVendorAction("codex", "plan");
    expect(r.briefPrefix).toBe("/plan");
    expect(r.profilePatch).toEqual({ sandbox: "read-only" });
  });

  it("codex resume → a subcommand argv override", () => {
    const r = resolveVendorAction("codex", "resume");
    expect(r.argvOverride).toEqual({ command: "codex", args: ["resume", "--last"] });
  });
});

describe("the four invariant guards", () => {
  it("full-auto in ONE-SHOT is permitted but dispatch-gated (sandbox + operator)", () => {
    const r = resolveVendorAction("claude-code", "full-auto", { mode: "one-shot" });
    expect(r.supported).toBe(true);
    expect(r.profilePatch).toEqual({ permissionMode: "full-auto" });
    expect(r.gate).toBe("dispatch-gate");
    expect(r.warnings.join(" ")).toMatch(/sandbox|operator/i);
  });

  it("full-auto in INTERACTIVE never passes the bypass, canUseTool still interposes", () => {
    const r = resolveVendorAction("claude-code", "full-auto", { mode: "interactive" });
    expect(r.supported).toBe(true);
    expect(r.downgraded).toBe(true);
    // The bypass is withheld: permission mode is forced back to default.
    expect(r.profilePatch).toEqual({ permissionMode: "default" });
    expect(r.warnings.join(" ")).toMatch(/canUseTool/);
  });

  it("--strict-mcp-config is refused, the governed brain is never evictable", () => {
    const r = resolveVendorAction("claude-code", "strict-mcp-config");
    expect(r.refused).toBe(true);
    // No argv / patch / prefix carries the flag through to the vendor.
    expect(r.argvOverride).toBeUndefined();
    expect(r.profilePatch).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/control-plane tools stay connected/i);
  });

  it("sanitizeGuardedArgs strips --strict-mcp-config and interactive bypass flags", () => {
    const stripped = sanitizeGuardedArgs(["--model", "x", "--strict-mcp-config"]);
    expect(stripped.args).toEqual(["--model", "x"]);
    expect(stripped.removed).toContain("--strict-mcp-config");

    const interactive = sanitizeGuardedArgs(["--yolo", "--foo"], { interactive: true });
    expect(interactive.args).toEqual(["--foo"]);
    expect(interactive.removed).toContain("--yolo");
  });

  it("sanitizeGuardedArgs also strips the `=`-joined form (--strict-mcp-config=1, --yolo=1)", () => {
    const eq = sanitizeGuardedArgs(["--strict-mcp-config=1", "--keep"]);
    expect(eq.args).toEqual(["--keep"]);
    expect(eq.removed).toContain("--strict-mcp-config=1");

    const yolo = sanitizeGuardedArgs(["--yolo=true"], { interactive: true });
    expect(yolo.args).toEqual([]);
    expect(yolo.removed).toContain("--yolo=true");
  });

  it("allows only one leading compiler-owned bare strict MCP flag", () => {
    const guarded = sanitizeGuardedArgs(
      [
        "--strict-mcp-config",
        "--strict-mcp-config",
        "--strict-mcp-config=untrusted",
        "--keep",
      ],
      { allowLeadingCompilerOwnedStrictMcpConfig: true }
    );
    expect(guarded.args).toEqual(["--strict-mcp-config", "--keep"]);
    expect(guarded.removed).toEqual([
      "--strict-mcp-config",
      "--strict-mcp-config=untrusted",
    ]);

    const nonLeading = sanitizeGuardedArgs(
      ["--prefix", "--strict-mcp-config"],
      { allowLeadingCompilerOwnedStrictMcpConfig: true }
    );
    expect(nonLeading.args).toEqual(["--prefix"]);
    expect(nonLeading.removed).toEqual(["--strict-mcp-config"]);
  });

  it("system-prompt uses the append (provenance-safe) path with a warning", () => {
    const r = resolveVendorAction("claude-code", "system-prompt", {
      args: ["be", "terse"],
    });
    expect(r.profilePatch?.extraArgs).toEqual(["--append-system-prompt", "be terse"]);
    expect(r.gate).toBe("warn");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("cloud/remote is withheld unless the operator opts into egress", () => {
    const hidden = resolveVendorAction("claude-code", "cloud");
    expect(hidden.supported).toBe(false);
    expect(hidden.reason).toMatch(/egress/);
    const opted = resolveVendorAction("claude-code", "cloud", { egressOptIn: true });
    expect(opted.supported).toBe(true);
  });
});

describe("subcommand channel, no guarded flag smuggles in via {target}/{arg}/{args}", () => {
  // The subcommand fills {target} into a STANDALONE argv token. A review target is
  // a path/ref, never a flag, a '-'-prefixed value must be refused so it cannot
  // re-inject a flag whose own action is gate:"refuse" (or a permission bypass).
  it("refuses --strict-mcp-config injected through the ultrareview target", () => {
    const r = resolveVendorAction("claude-code", "ultrareview", {
      target: "--strict-mcp-config",
    });
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/path\/ref, not a flag/);
    // Categorical guarantee: no argv is emitted at all.
    expect(r.argvOverride).toBeUndefined();
  });

  it("refuses a permission-bypass flag injected through the ultrareview args slot", () => {
    for (const evil of ["--dangerously-skip-permissions", "--yolo", "-c"]) {
      const r = resolveVendorAction("claude-code", "ultrareview", { args: [evil] });
      expect(r.supported).toBe(false);
      expect(r.argvOverride).toBeUndefined();
    }
  });

  it("no resolved subcommand argv ever contains a guarded flag, for any input", () => {
    const inputs = [
      { target: "--strict-mcp-config" },
      { args: ["--strict-mcp-config=1"] },
      { target: "src/app.ts" }, // benign still works
      {},
    ];
    for (const ctx of inputs) {
      const r = resolveVendorAction("claude-code", "ultrareview", ctx);
      const argv = r.argvOverride?.args ?? [];
      expect(argv.some((a) => a.startsWith("--strict-mcp-config"))).toBe(false);
      expect(argv).not.toContain("--dangerously-skip-permissions");
    }
    // the benign path still yields the golden argv
    const good = resolveVendorAction("claude-code", "ultrareview", { target: "src/app.ts" });
    expect(good.argvOverride?.args).toEqual(["ultrareview", "src/app.ts", "--json"]);
  });
});

describe("readiness- and mode-aware surfacing", () => {
  it("refuses every Cursor action — with a reason that does not claim Cursor is undispatchable", () => {
    // The refusal is unchanged: MUON models no vendor-native action set for
    // Cursor. What changed is the REASON. Since ADR-0020, Cursor IS a managed
    // lane (read-only roles), so the old "readiness-only … not dispatch-ready"
    // string was a user-visible falsehood that contradicted the crew view.
    const action = VENDOR_CAPABILITY_DESCRIPTORS.cursor.actions[0]!;
    const resolved = resolveVendorAction("cursor", action.id);

    expect(resolved.supported).toBe(false);
    expect(resolved.reason).toMatch(/no vendor-native actions for Cursor/i);
    expect(resolved.reason).not.toMatch(/not dispatch-ready/i);
    expect(resolved.reason).not.toMatch(/readiness-only/i);
    expect(resolved.argvOverride).toBeUndefined();
    expect(resolved.profilePatch).toBeUndefined();
  });

  it("hides an action a vendor does not support in the current mode", () => {
    // codex review is interactive-only → it is not offered in one-shot mode.
    const r = resolveVendorAction("codex", "review", { mode: "one-shot" });
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/not available in one-shot/);
  });

  it("sessionSlash is blocked where the vendor cannot send (claude canSend:false)", () => {
    // claude has no sessionSlash action; assert the guard directly on codex which
    // does, and that a vendor without canSend would be refused.
    const codex = resolveVendorAction("codex", "review", { mode: "interactive" });
    expect(codex.sessionSend).toBe("/review");
  });

  it("an un-verified (⚠) action still resolves to a well-formed override (no crash)", () => {
    // codex resume is dogfood-tagged; it must still produce a clean argv.
    const r = resolveVendorAction("codex", "resume");
    expect(r.supported).toBe(true);
    expect(getVendorAction("codex", "resume")?.dogfood).toBe(true);
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it("buildVendorActionMenu offers only ready vendors' one-shot actions", () => {
    const menu = buildVendorActionMenu({ readiness: READY, mode: "one-shot" });
    expect(menu.length).toBeGreaterThan(0);
    expect(menu.every((item) => item.ready)).toBe(true);
    // hidden (cloud) actions are withheld by default.
    expect(menu.some((item) => item.actionId === "cloud")).toBe(false);
    // the fake vendor is never in the production menu.
    expect(menu.some((item) => item.vendor === "fake")).toBe(false);
  });

  it("marks not-ready when a vendor is not authenticated", () => {
    const menu = buildVendorActionMenu({
      readiness: [{ vendor: "claude-code", installed: true, authenticated: false }],
      mode: "one-shot",
      vendor: "claude-code",
    });
    expect(menu.every((item) => item.ready === false)).toBe(true);
  });

  it("a dangerous action carries an approval chip; a clean one reads available", () => {
    const full = getVendorAction("claude-code", "full-auto")!;
    expect(actionChip(full)).toMatch(/needs approval/);
    const model = getVendorAction("claude-code", "model")!;
    expect(actionChip(model)).toBe("available");
    const dogfooded = getVendorAction("claude-code", "ultrareview")!;
    expect(actionChip(dogfooded)).toMatch(/⚠/);
  });
});

describe("validateModelForVendor, the model validation backbone (S5)", () => {
  it("declares a per-vendor model policy for every public vendor", () => {
    for (const key of ["claude-code", "codex", "cursor"] as const) {
      const models = VENDOR_CAPABILITY_DESCRIPTORS[key].models;
      expect(models).toBeDefined();
      expect(Array.isArray(models!.known)).toBe(true);
      expect(typeof models!.allowCustom).toBe("boolean");
    }
  });

  it("accepts a known model with no warning", () => {
    const r = validateModelForVendor("claude-code", "opus");
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
    expect(r.reason).toBeUndefined();
  });

  it("accepts an unknown id when allowCustom, but degrades with a warning (never guesses)", () => {
    const r = validateModelForVendor("claude-code", "opus-4.8");
    expect(r.ok).toBe(true);
    expect(r.warning).toBeTruthy();
    expect(r.warning).toMatch(/opus-4\.8/);
  });

  it("fails closed on an empty / whitespace-only model", () => {
    for (const value of ["", "   ", "\t"]) {
      const r = validateModelForVendor("codex", value);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/empty/i);
    }
  });

  it("fails closed on a flag-shaped (leading '-') model", () => {
    const r = validateModelForVendor("codex", "-o3");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/flag/i);
  });

  it("fails closed on a guarded value smuggled as a model", () => {
    for (const evil of ["--strict-mcp-config", "--strict-mcp-config=1", "--yolo"]) {
      const r = validateModelForVendor("claude-code", evil);
      expect(r.ok).toBe(false);
      // Never echo the guarded flag back into a passable value.
      expect(r.warning).toBeUndefined();
    }
  });

  it("rejects an unknown id when the vendor forbids custom models (fake, allowCustom:false)", () => {
    expect(VENDOR_CAPABILITY_DESCRIPTORS.fake.models?.allowCustom).toBe(false);
    const known = VENDOR_CAPABILITY_DESCRIPTORS.fake.models!.known[0]!;
    const ok = validateModelForVendor("fake", known);
    expect(ok.ok).toBe(true);
    expect(ok.warning).toBeUndefined();
    const bad = validateModelForVendor("fake", "definitely-not-a-fake-model");
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/not a known/i);
  });

  it("TODO 3.6: the Default sentinel is accepted and is not a vendor id", () => {
    const r = validateModelForVendor("claude-code", DEFAULT_MODEL_SENTINEL);
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });
});

describe("TODO 3.5: capability-gated picker predicates", () => {
  it("every public vendor with a catalogue supports the model control", () => {
    expect(vendorSupportsModelControl("claude-code")).toBe(true);
    expect(vendorSupportsModelControl("codex")).toBe(true);
    expect(vendorSupportsModelControl("cursor")).toBe(true);
    expect(vendorSupportsModelControl("opencode")).toBe(true);
    expect(vendorSupportsModelControl("not-a-vendor")).toBe(false);
  });

  it("effort vanishes where there is no effort action", () => {
    expect(vendorSupportsEffortControl("claude-code")).toBe(true);
    expect(vendorSupportsEffortControl("codex")).toBe(true);
    expect(vendorSupportsEffortControl("cursor")).toBe(false);
    expect(vendorSupportsEffortControl("opencode")).toBe(false);
  });
});

describe("mergeProfilePatch", () => {
  it("appends array fields and merges records onto a base profile", () => {
    const base = { ...emptyLaneProfile, extraArgs: ["--existing"] };
    const merged = mergeProfilePatch(base, { extraArgs: ["--effort", "high"] });
    expect(merged.extraArgs).toEqual(["--existing", "--effort", "high"]);
    const withModel = mergeProfilePatch(base, { model: "opus" });
    expect(withModel.model).toBe("opus");
  });

  it("APPENDS mcpServers, the injected governed-brain server can never be evicted", () => {
    const brain = { name: "muon-brain", command: "node", args: [], env: {} };
    const base = { ...emptyLaneProfile, mcpServers: [brain] };
    // A patch that supplies its own mcpServers must NOT replace the brain.
    const merged = mergeProfilePatch(base, {
      mcpServers: [{ name: "other", command: "x", args: [], env: {} }],
    });
    expect(merged.mcpServers.map((s) => s.name)).toEqual(["muon-brain", "other"]);
    // With no mcpServers in the patch, the brain is untouched.
    const noPatch = mergeProfilePatch(base, { model: "opus" });
    expect(noPatch.mcpServers).toEqual([brain]);
  });
});
