import { BrowserWindow, type WebContents } from "electron";
import {
  isAllowedPortPreviewUrl,
  resolvePortPreviewUrl,
} from "./port-preview-security.js";

type GuardedWebContents = Pick<
  WebContents,
  "on" | "setWindowOpenHandler"
>;

export function installPortPreviewGuards(
  webContents: GuardedWebContents
): void {
  const denyUnlessAllowed = (event: { preventDefault(): void }, url: string) => {
    if (!isAllowedPortPreviewUrl(url)) {
      event.preventDefault();
    }
  };
  webContents.on("will-navigate", (event, url) => {
    denyUnlessAllowed(event, url);
  });
  webContents.on("will-redirect", (event, url) => {
    denyUnlessAllowed(event, url);
  });
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

const previewWindows = new Set<BrowserWindow>();

export function openPortPreviewWindow(port: number): void {
  const url = resolvePortPreviewUrl(port);
  if (!url) {
    throw new Error("Refusing to open a preview for an invalid port.");
  }

  for (const existing of previewWindows) {
    if (!existing.isDestroyed()) {
      existing.close();
    }
    previewWindows.delete(existing);
  }

  const win = new BrowserWindow({
    width: 960,
    height: 720,
    title: `Preview · 127.0.0.1:${port}`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  previewWindows.add(win);
  win.on("closed", () => {
    previewWindows.delete(win);
  });
  installPortPreviewGuards(win.webContents);
  void win.loadURL(url);
}

export function closePortPreviewWindows(): void {
  for (const win of previewWindows) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
  previewWindows.clear();
}
