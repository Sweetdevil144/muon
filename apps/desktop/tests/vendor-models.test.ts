import { describe, expect, it } from "vitest";
import { listVendorModels } from "../src/lib/vendor-models.js";

describe("listVendorModels", () => {
  it("returns Claude Code latest aliases without shelling out", async () => {
    const catalog = await listVendorModels("claude-code");
    expect(catalog.source).toBe("fallback");
    expect(catalog.models.map((m) => m.id)).toEqual([
      "fable",
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  it("returns Codex models from CLI or the latest fallback list", async () => {
    const catalog = await listVendorModels("codex");
    expect(catalog.vendor).toBe("codex");
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.models.some((m) => m.id.includes("gpt-5.6") || m.id.includes("gpt-5"))).toBe(
      true
    );
    expect(catalog.models.every((m) => m.id !== "codex-auto-review")).toBe(true);
  });

  it("TODO 3.1/3.2: Cursor catalogue comes from CLI when available, else live fallback", async () => {
    const catalog = await listVendorModels("cursor");
    expect(catalog.vendor).toBe("cursor");
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.models.some((m) => m.id === "auto")).toBe(true);
    // Stale registry ids must never be the only options.
    expect(catalog.models.every((m) => m.id !== "sonnet")).toBe(true);
    expect(catalog.models.every((m) => m.id !== "opus")).toBe(true);
    if (catalog.source === "cli") {
      expect(
        catalog.models.some(
          (m) =>
            m.id.includes("gpt-5.6-sol") ||
            m.id.includes("claude-opus") ||
            m.id.includes("kimi")
        )
      ).toBe(true);
    }
  });

  it("TODO 3.1: OpenCode catalogue comes from CLI when available", async () => {
    const catalog = await listVendorModels("opencode");
    expect(catalog.vendor).toBe("opencode");
    if (catalog.source === "cli") {
      expect(catalog.models.length).toBeGreaterThan(10);
      expect(catalog.models.every((m) => m.id.includes("/"))).toBe(true);
    } else {
      // No binary / probe failed — honest empty fallback (operator-configured).
      expect(catalog.models).toEqual([]);
    }
  });
});
