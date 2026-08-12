import { describe, expect, it } from "vitest";
import {
  isNearBottom,
  NEAR_BOTTOM_PX,
} from "../src/renderer/lib/stick-scroll.js";

function fakeScrollEl(input: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): HTMLElement {
  return input as unknown as HTMLElement;
}

describe("isNearBottom (chat stick-to-bottom)", () => {
  it("treats the exact bottom as following", () => {
    expect(
      isNearBottom(
        fakeScrollEl({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 })
      )
    ).toBe(true);
  });

  it("still follows within the near-bottom threshold", () => {
    expect(
      isNearBottom(
        fakeScrollEl({
          scrollHeight: 1000,
          scrollTop: 700 - NEAR_BOTTOM_PX,
          clientHeight: 300,
        })
      )
    ).toBe(true);
  });

  it("releases the stick when the user scrolls further up", () => {
    expect(
      isNearBottom(
        fakeScrollEl({
          scrollHeight: 1000,
          scrollTop: 700 - NEAR_BOTTOM_PX - 1,
          clientHeight: 300,
        })
      )
    ).toBe(false);
  });
});
