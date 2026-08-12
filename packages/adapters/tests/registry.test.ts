import { describe, expect, it } from "vitest";
import { createDefaultAdapters } from "../src/registry.js";

describe("adapter registry", () => {
  it("registers every dispatchable lane, including the read-only ones", () => {
    const adapters = createDefaultAdapters();
    expect(adapters.map((adapter) => adapter.id)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "opencode",
    ]);
  });
});
