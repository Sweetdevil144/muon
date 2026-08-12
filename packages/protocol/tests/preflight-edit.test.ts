import { describe, expect, it } from "vitest";
import { gitCommitsMatch } from "../src/index.js";

describe("preflight edit commit evidence", () => {
  it("accepts GitNexus abbreviated commits for the same full Git revision", () => {
    expect(
      gitCommitsMatch(
        "53aca6f",
        "53aca6ff35be1c1b225feb3e60eccf05e220cc2b"
      )
    ).toBe(true);
  });

  it("rejects different or untrustworthily short commit coordinates", () => {
    expect(gitCommitsMatch("53aca6f", "d148ccc")).toBe(false);
    expect(gitCommitsMatch("53ac", "53aca6ff35be")).toBe(false);
  });
});
