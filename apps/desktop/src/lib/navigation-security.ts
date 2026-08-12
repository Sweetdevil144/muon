import type { WebContents } from "electron";

type GuardedWebContents = Pick<
  WebContents,
  "on" | "setWindowOpenHandler"
>;

/**
 * Keep the privileged preload renderer pinned to its packaged local document.
 * Renderer content is untrusted (agent/model/repository text), so neither a
 * same-window navigation nor a popup may create a remote renderer that retains
 * MUON's preload bridge.
 */
export function installNavigationGuards(webContents: GuardedWebContents): void {
  const preventNavigation = (event: { preventDefault(): void }) => {
    event.preventDefault();
  };
  webContents.on("will-navigate", preventNavigation);
  webContents.on("will-frame-navigate", preventNavigation);
  webContents.on("will-redirect", preventNavigation);
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}
