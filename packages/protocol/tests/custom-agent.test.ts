import { describe, expect, it } from "vitest";
import { isVendorId, VENDOR_IDS, vendorIdSchema } from "../src/vendor.js";
import {
  CUSTOM_AGENT_ID_PREFIX,
  CUSTOM_AGENT_SLUG_PATTERN,
  MAX_CUSTOM_AGENTS,
  UNGOVERNED_AUTHORITY,
  createUngovernedAgentEntry,
  customAgentId,
  customAgentRegistrationInputSchema,
  isUngovernedAgentEntry,
  isUngovernedAgentId,
  parseUngovernedAgentEntry,
  ungovernedAgentEntrySchema,
  ungovernedAgentLabel,
  ungovernedAgentSlug,
} from "../src/custom-agent.js";

describe("ROADMAP P7 — the ungoverned custom-agent tier is POSITIVELY defined", () => {
  it("UNGOVERNED_AUTHORITY grants exactly one thing: terminalTabOnly", () => {
    expect(UNGOVERNED_AUTHORITY.terminalTabOnly).toBe(true);
    for (const [field, value] of Object.entries(UNGOVERNED_AUTHORITY)) {
      if (field === "terminalTabOnly") continue;
      if (field === "supportedRoles") {
        expect(value, "supportedRoles must be []").toEqual([]);
        continue;
      }
      expect(value, `${field} must be false — the tier grants nothing else`).toBe(
        false
      );
    }
  });

  it("has NO input field that could widen authority (ADR-0022 rule 2, no subtraction/allow-by-omission)", () => {
    // The registration schema is the only door an operator has. If it ever
    // grows an `authority` key, THIS is the assertion that must be updated
    // deliberately — it cannot happen by someone forgetting to strip a field.
    const shape = customAgentRegistrationInputSchema.shape;
    expect(Object.keys(shape).sort()).toEqual(
      ["args", "command", "displayName", "iconKey", "shortLabel", "slug"].sort()
    );
    expect(shape).not.toHaveProperty("authority");
  });

  it("createUngovernedAgentEntry always attaches the SAME authority object", () => {
    const a = createUngovernedAgentEntry({
      slug: "agent-a",
      displayName: "Agent A",
      command: "agent-a-bin",
      args: [],
    });
    const b = createUngovernedAgentEntry({
      slug: "agent-b",
      displayName: "Agent B",
      command: "agent-b-bin",
      args: ["--flag"],
    });
    // Identity, not merely value equality — every entry points at the ONE
    // shared constant.
    expect(a.authority).toBe(UNGOVERNED_AUTHORITY);
    expect(b.authority).toBe(UNGOVERNED_AUTHORITY);
  });

  it("id is always custom:<slug> — never constructed any other way", () => {
    const entry = createUngovernedAgentEntry({
      slug: "my-terminal-agent",
      displayName: "My Terminal Agent",
      command: "my-agent",
      args: [],
    });
    expect(entry.id).toBe("custom:my-terminal-agent");
    expect(customAgentId("my-terminal-agent")).toBe(entry.id);
  });
});

describe("identity is DISJOINT from the VendorId namespace by construction", () => {
  it("no VendorId ever satisfies isUngovernedAgentId", () => {
    for (const id of VENDOR_IDS) {
      expect(isUngovernedAgentId(id), `${id} must not look like a custom agent`).toBe(
        false
      );
    }
  });

  it("no custom agent id ever satisfies isVendorId", () => {
    const entry = createUngovernedAgentEntry({
      slug: "demo-agent",
      displayName: "Demo Agent",
      command: "demo-agent-bin",
      args: [],
    });
    expect(isVendorId(entry.id)).toBe(false);
    expect(vendorIdSchema.safeParse(entry.id).success).toBe(false);
  });

  it("no VendorId literal contains the custom-agent prefix character", () => {
    // The disjointness is not an accident of today's four vendor names — it is
    // structural (`:` vs no `:`). This pins the premise directly.
    for (const id of VENDOR_IDS) {
      expect(id.includes(":")).toBe(false);
    }
    expect(CUSTOM_AGENT_ID_PREFIX.includes(":")).toBe(true);
  });

  it("the plain-shell kind ('shell') can never be registered as a custom agent slug", () => {
    expect(CUSTOM_AGENT_SLUG_PATTERN.test("shell")).toBe(true); // shape-legal…
    expect(
      customAgentRegistrationInputSchema.safeParse({
        slug: "shell",
        displayName: "Shell",
        command: "sh",
        args: [],
      }).success
    ).toBe(false); // …but refused, because it collides with SHELL_TERMINAL_KIND.
  });
});

describe("registration input validation", () => {
  it("accepts a minimal valid registration", () => {
    const result = customAgentRegistrationInputSchema.safeParse({
      slug: "opencode-nightly",
      displayName: "OpenCode Nightly",
      command: "opencode-nightly",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.args).toEqual([]);
    }
  });

  it.each([
    ["", "empty slug"],
    ["Has-Caps", "uppercase"],
    ["-leading-hyphen", "leading hyphen"],
    ["has space", "space"],
    ["has/slash", "slash"],
    ["a".repeat(65), "too long"],
  ])("rejects an invalid slug: %s (%s)", (slug) => {
    expect(
      customAgentRegistrationInputSchema.safeParse({
        slug,
        displayName: "X",
        command: "x",
      }).success
    ).toBe(false);
  });

  it("rejects an empty displayName or command", () => {
    expect(
      customAgentRegistrationInputSchema.safeParse({
        slug: "valid-slug",
        displayName: "",
        command: "x",
      }).success
    ).toBe(false);
    expect(
      customAgentRegistrationInputSchema.safeParse({
        slug: "valid-slug",
        displayName: "X",
        command: "",
      }).success
    ).toBe(false);
  });

  it("rejects an authority field smuggled onto the input (extra keys ignored, not honoured)", () => {
    const parsed = customAgentRegistrationInputSchema.parse({
      slug: "valid-slug",
      displayName: "X",
      command: "x",
      // @ts-expect-error — deliberately probing a field that does not exist.
      authority: { dispatchable: true },
    });
    expect(parsed).not.toHaveProperty("authority");
  });
});

describe("persisted-entry validation (ungovernedAgentEntrySchema)", () => {
  const validEntry = () =>
    createUngovernedAgentEntry({
      slug: "demo",
      displayName: "Demo",
      command: "demo-bin",
      args: ["--flag"],
    });

  it("round-trips a valid entry", () => {
    const entry = validEntry();
    expect(ungovernedAgentEntrySchema.safeParse(entry).success).toBe(true);
    expect(isUngovernedAgentEntry(entry)).toBe(true);
    expect(parseUngovernedAgentEntry(entry)).toEqual(entry);
  });

  it("rejects an entry whose id lacks the custom: prefix", () => {
    const tampered = { ...validEntry(), id: "claude-code" };
    expect(ungovernedAgentEntrySchema.safeParse(tampered).success).toBe(false);
    expect(parseUngovernedAgentEntry(tampered)).toBeNull();
  });

  it("REJECTS a hand-edited entry that flips ANY authority bit — the whole point of the schema", () => {
    const base = validEntry();
    const widenings = [
      { ...base.authority, dispatchable: true },
      { ...base.authority, coordinatorSeat: true },
      { ...base.authority, delegatable: true },
      { ...base.authority, fleetSizeable: true },
      { ...base.authority, evaluator: true },
      { ...base.authority, planner: true },
      { ...base.authority, brainAccess: true },
      { ...base.authority, mcpInstall: true },
      { ...base.authority, terminalTabOnly: false },
      { ...base.authority, supportedRoles: ["scout"] },
    ];
    for (const authority of widenings) {
      const tampered = { ...base, authority };
      expect(
        ungovernedAgentEntrySchema.safeParse(tampered).success,
        `must reject ${JSON.stringify(authority)}`
      ).toBe(false);
      expect(parseUngovernedAgentEntry(tampered)).toBeNull();
    }
  });

  it("parseUngovernedAgentEntry re-stamps authority to the shared constant on success", () => {
    const entry = validEntry();
    const roundTripped = parseUngovernedAgentEntry(JSON.parse(JSON.stringify(entry)));
    expect(roundTripped).not.toBeNull();
    expect(roundTripped!.authority).toBe(UNGOVERNED_AUTHORITY);
  });

  it("rejects a non-object, null, and garbage input without throwing", () => {
    for (const bad of [null, undefined, 42, "custom:x", [], {}]) {
      expect(() => parseUngovernedAgentEntry(bad)).not.toThrow();
      expect(parseUngovernedAgentEntry(bad)).toBeNull();
    }
  });
});

describe("small helpers", () => {
  it("ungovernedAgentSlug extracts the slug, or null for a non-custom id", () => {
    expect(ungovernedAgentSlug("custom:my-agent")).toBe("my-agent");
    expect(ungovernedAgentSlug("claude-code")).toBeNull();
    expect(ungovernedAgentSlug(42)).toBeNull();
  });

  it("ungovernedAgentLabel falls back to the raw id when unknown (never blank)", () => {
    expect(ungovernedAgentLabel("custom:missing", [])).toBe("custom:missing");
    const entry = createUngovernedAgentEntry({
      slug: "known",
      displayName: "Known Agent",
      command: "known-bin",
      args: [],
    });
    expect(ungovernedAgentLabel(entry.id, [entry])).toBe("Known Agent");
  });

  it("MAX_CUSTOM_AGENTS is a small positive bound", () => {
    expect(MAX_CUSTOM_AGENTS).toBeGreaterThan(0);
    expect(MAX_CUSTOM_AGENTS).toBeLessThanOrEqual(100);
  });
});
