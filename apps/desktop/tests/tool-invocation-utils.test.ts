import { describe, expect, it } from "vitest";
import { idToReadableText } from "../src/renderer/ui/tool-invocation-utils.js";

describe("idToReadableText", () => {
  it("spaces snake and strips mcp prefix", () => {
    expect(idToReadableText("search_database")).toBe("Search Database");
    expect(idToReadableText("mcp__code_graph")).toBe("Code Graph");
  });

  it("can leave casing alone", () => {
    expect(idToReadableText("dispatch-job", { capitalize: false })).toBe(
      "dispatch job"
    );
  });
});
