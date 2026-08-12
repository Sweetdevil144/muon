import { describe, expect, it } from "vitest";
import {
  principalColor,
  principalColorVar,
} from "../src/lib/principal-color.js";

describe("principalColor (TODO 7.10)", () => {
  it("is stable for the same principal", () => {
    expect(principalColor("agent:claude-1")).toBe(
      principalColor("agent:claude-1")
    );
  });

  it("separates distinct principals", () => {
    expect(principalColor("agent:claude-1")).not.toBe(
      principalColor("agent:codex-1")
    );
  });

  it("emits an hsl() token", () => {
    expect(principalColor("reviewer")).toMatch(/^hsl\(\d+ 62% 52%\)$/);
  });

  it("builds a CSS variable name", () => {
    expect(principalColorVar("Agent:Claude/1")).toBe("--principal-agent-claude-1");
  });
});
