import { describe, expect, it } from "vitest";
import { formatDuration } from "../src/lib/format-duration.js";

describe("formatDuration", () => {
  it("formats milliseconds under a second", () => {
    expect(formatDuration(450)).toBe("450ms");
  });

  it("formats seconds", () => {
    expect(formatDuration(2500)).toBe("2.5s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(150000)).toBe("2m 30s");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3660000)).toBe("1h 1m");
  });

  it("renders n/a for null", () => {
    expect(formatDuration(null)).toBe("n/a");
  });
});
