import { describe, expect, it } from "vitest";
import { stdinBriefDeliveryStall } from "../src/stdin-stall.js";

describe("stdinBriefDeliveryStall", () => {
  it("names brief delivery for the exact line the founder's terminal showed", () => {
    const cause = stdinBriefDeliveryStall(
      "Reading additional input from stdin...\n"
    );

    expect(cause).toBeDefined();
    expect(cause).toContain("stdin");
    expect(cause).toContain("argv");
    // The whole point: it must NOT send the operator hunting for the causes the
    // generic stall message suggests.
    expect(cause).toContain("not quota, auth, or an MCP handshake");
  });

  it("matches regardless of case and surrounding vendor banner text", () => {
    expect(
      stdinBriefDeliveryStall(
        ["OpenAI Codex v0.145.0", "READING ADDITIONAL INPUT FROM STDIN..."].join(
          "\n"
        )
      )
    ).toBeDefined();
  });

  it("stays silent when the vendor never said it was reading stdin", () => {
    // Silence has many causes; claiming this one without evidence is the same
    // defect as the generic message it replaces.
    expect(stdinBriefDeliveryStall("")).toBeUndefined();
    expect(
      stdinBriefDeliveryStall("thinking...\nrate limit exceeded, retrying")
    ).toBeUndefined();
    expect(
      stdinBriefDeliveryStall("wrote 3 files to stdin_helpers/")
    ).toBeUndefined();
  });
});
