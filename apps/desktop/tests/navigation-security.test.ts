import { describe, expect, it, vi } from "vitest";
import { installNavigationGuards } from "../src/lib/navigation-security.js";

describe("installNavigationGuards", () => {
  it("blocks renderer navigation, frame navigation, redirects, and popups", () => {
    const handlers = new Map<
      string,
      (event: { preventDefault(): void }) => void
    >();
    const webContents = {
      on: vi.fn(
        (
          channel: string,
          handler: (event: { preventDefault(): void }) => void
        ) => {
          handlers.set(channel, handler);
          return webContents;
        }
      ),
      setWindowOpenHandler: vi.fn(),
    };

    installNavigationGuards(
      webContents as unknown as Parameters<typeof installNavigationGuards>[0]
    );

    for (const channel of [
      "will-navigate",
      "will-frame-navigate",
      "will-redirect",
    ]) {
      const event = { preventDefault: vi.fn() };
      handlers.get(channel)?.(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    const openHandler = webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(openHandler?.({ url: "https://attacker.invalid" })).toEqual({
      action: "deny",
    });
  });
});
