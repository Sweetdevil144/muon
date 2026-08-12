import { describe, expect, it } from "vitest";
import {
  describeDrift,
  describeEnabledItem,
  diffServerNames,
  enableRefusalForKind,
  ENABLEABLE_ITEM_KINDS,
  enabledItemSchema,
  isEnableableKind,
  materializeEnabledServer,
  type EnabledItem,
  type ImportedItem,
} from "../src/index.js";
import { importItemDigest } from "../src/compatibility-digest.js";

/**
 * ADR-0038 slice 2 — the RULES of enable, tested where they are pure.
 *
 * Slice 1 was deliberately incapable of granting anything. This slice can, and
 * these are the properties that make it a governed act rather than an import
 * button. Each maps to a decision in the ADR, and each is written so that a
 * later convenience — a bulk verb, a "just this once" widening, a kind added
 * without an attestation — fails here first.
 */

function item(over: Partial<ImportedItem> = {}): ImportedItem {
  return {
    kind: "mcp_server",
    name: "linear",
    provenance: { vendor: "claude", sourcePath: "/home/a/.claude.json" },
    shape: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "linear-mcp"],
      envKeys: ["LINEAR_API_KEY"],
      headerKeys: [],
    },
    secretsRefused: ["LINEAR_API_KEY"],
    state: "discovered",
    ...over,
  } as ImportedItem;
}

describe("D7 — what may be enabled is a POSITIVE list of one", () => {
  it("enables MCP servers", () => {
    expect(enableRefusalForKind("mcp_server")).toBeNull();
    expect(isEnableableKind("mcp_server")).toBe(true);
  });

  it.each(["skill", "hook", "plugin", "rule", "", "MCP_SERVER"])(
    "refuses %j, with a reason",
    (kind) => {
      const refusal = enableRefusalForKind(kind);
      expect(refusal, kind).not.toBeNull();
      expect(refusal, "ADR-0033: a refusal explains itself").toContain(
        "ADR-0038 D7"
      );
      expect(isEnableableKind(kind)).toBe(false);
    }
  );

  it("the list is exactly one kind — a second needs its attestation first", () => {
    // If this fails, someone added a kind. That is allowed, and it must come
    // with the attestation story D7 names as the reason for the restriction —
    // which means changing this test deliberately, not by accident.
    expect([...ENABLEABLE_ITEM_KINDS]).toEqual(["mcp_server"]);
  });
});

describe("D3 — the fingerprint an approval is bound to", () => {
  it("is stable across identical items", () => {
    expect(importItemDigest(item())).toBe(importItemDigest(item()));
  });

  it("ignores where the config file lives", () => {
    // D3: a moved config file is not a changed item.
    expect(
      importItemDigest(
        item({ provenance: { vendor: "claude", sourcePath: "/elsewhere.json" } })
      )
    ).toBe(importItemDigest(item()));
  });

  it("changes when anything that DECIDES WHAT RUNS changes", () => {
    const base = importItemDigest(item());
    const mutations: Array<[string, ImportedItem]> = [
      ["command", item({ shape: { ...item().shape, command: "curl" } })],
      ["args", item({ shape: { ...item().shape, args: ["-y", "evil-mcp"] } })],
      [
        "a new credential requirement",
        item({ shape: { ...item().shape, envKeys: ["LINEAR_API_KEY", "AWS_SECRET"] } }),
      ],
      ["transport", item({ shape: { ...item().shape, transport: "http" } })],
      ["name", item({ name: "linear-2" })],
      [
        "vendor",
        item({ provenance: { vendor: "codex", sourcePath: "/home/a/.claude.json" } }),
      ],
    ];
    for (const [what, mutated] of mutations) {
      expect(importItemDigest(mutated), what).not.toBe(base);
    }
  });

  it("is a sha256, so a stored digest is comparable forever", () => {
    expect(importItemDigest(item())).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("D5 — the shape reaches the lane, the credentials never do", () => {
  it("materializes with an EMPTY env, however many the item names", () => {
    const server = materializeEnabledServer(item());
    expect(server.env).toEqual({});
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "linear-mcp"]);
  });

  it("carries a url item as a url item", () => {
    const server = materializeEnabledServer(
      item({
        shape: {
          transport: "http",
          args: [],
          url: "https://mcp.example.com/mcp",
          envKeys: [],
          headerKeys: ["Authorization"],
        },
      })
    );
    expect(server.url).toBe("https://mcp.example.com/mcp");
    expect(server.command).toBeUndefined();
    expect(server.env).toEqual({});
  });
});

describe("D2 — the diff is a statement about state, not about intent", () => {
  it("names what changed, both ways, sorted", () => {
    expect(diffServerNames(["b", "a"], ["a", "c"])).toEqual({
      before: ["a", "b"],
      after: ["a", "c"],
      added: ["c"],
      removed: ["b"],
    });
  });

  it("an enable that changes nothing says so, rather than claiming an add", () => {
    // Re-enabling something already enabled is a real case (a human
    // re-approving after drift), and reporting a phantom "+1 server" would be
    // exactly the plan-as-change lie D2 rejects.
    const diff = diffServerNames(["linear"], ["linear"]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
});

describe("the sentences every surface shares", () => {
  const enabled: EnabledItem = enabledItemSchema.parse({
    kind: "mcp_server",
    name: "linear",
    vendor: "claude",
    laneKey: "claude",
    enabledDigest: `sha256:${"a".repeat(64)}`,
    state: "enabled",
    secretsRefused: ["LINEAR_API_KEY"],
    enabledBy: "human:casey",
    enabledAt: "2026-08-09T10:00:00.000Z",
  });

  it("an enabled item names its lane and its missing credentials", () => {
    const line = describeEnabledItem(enabled);
    expect(line).toContain("linear");
    expect(line).toContain("lane claude");
    expect(line).toContain("LINEAR_API_KEY");
  });

  it("a drift-disabled item says it was disabled, not that it is fine", () => {
    const line = describeEnabledItem({ ...enabled, state: "disabled-drift" });
    expect(line).toContain("DISABLED");
    expect(line).toContain("changed after it was approved");
  });

  it("states no risk score and no recommendation", () => {
    // The rule `describeImportedItem` set: a surface that says "this one looks
    // fine" is one an importer learns to trust instead of reading.
    for (const line of [
      describeEnabledItem(enabled),
      describeEnabledItem({ ...enabled, state: "disabled-drift" }),
    ]) {
      expect(line.toLowerCase()).not.toMatch(
        /\b(safe|trusted|low risk|recommended|looks fine)\b/
      );
    }
  });

  it("distinguishes a VANISHED item from a CHANGED one", () => {
    // Different facts a human answers differently: a server gone from the
    // config is usually their own edit; one whose shape moved is the case
    // worth stopping for.
    const gone = describeDrift({
      name: "linear",
      vendor: "claude",
      approvedDigest: `sha256:${"a".repeat(64)}`,
      observedDigest: "absent",
      reason: "",
    });
    const changed = describeDrift({
      name: "linear",
      vendor: "claude",
      approvedDigest: `sha256:${"a".repeat(64)}`,
      observedDigest: `sha256:${"b".repeat(64)}`,
      reason: "",
    });
    expect(gone).toContain("no longer in");
    expect(changed).toContain("shape changed");
    expect(gone).not.toBe(changed);
  });
});
