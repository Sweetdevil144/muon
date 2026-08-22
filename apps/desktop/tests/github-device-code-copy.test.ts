/**
 * The device flow's one manual step is transcribing an 8-character code into a
 * browser that is about to take focus. Copying it is the difference between
 * "paste" and "read it off a window you can no longer see".
 *
 * The invariant that matters most here is the failure one: a clipboard that
 * refuses must never block sign-in, because the code is still on screen and
 * still typable.
 */
import { describe, expect, it, vi } from "vitest";
import { copyDeviceCode } from "../src/renderer/sidebar.js";

describe("copyDeviceCode", () => {
  it("writes the code and reports success", async () => {
    const writeText = vi.fn(async () => undefined);
    expect(await copyDeviceCode("ABCD-1234", { writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith("ABCD-1234");
  });

  it("reports failure instead of throwing when the clipboard refuses", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    // If this threw, `start()` would abort before opening the browser and the
    // whole sign-in would fail because a convenience did.
    await expect(copyDeviceCode("ABCD-1234", { writeText })).resolves.toBe(false);
  });

  it("reports failure when there is no clipboard at all", async () => {
    expect(await copyDeviceCode("ABCD-1234", undefined)).toBe(false);
  });

  it("never writes an empty code", async () => {
    const writeText = vi.fn(async () => undefined);
    expect(await copyDeviceCode("", { writeText })).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
