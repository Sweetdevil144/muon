import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAppIconPath } from "../src/lib/app-icon.js";

describe("resolveAppIconPath", () => {
  it("uses electron-builder's packaged Resources/icon.icns location", () => {
    expect(
      resolveAppIconPath({
        packaged: true,
        resourcesPath: "/Applications/MUON.app/Contents/Resources",
        moduleDir: "/unused",
      })
    ).toBe("/Applications/MUON.app/Contents/Resources/icon.icns");
  });

  it("uses the generated build icon during development", () => {
    expect(
      resolveAppIconPath({
        packaged: false,
        resourcesPath: "/unused",
        moduleDir: path.join("/repo", "apps", "desktop", "dist"),
      })
    ).toBe(path.join("/repo", "apps", "desktop", "build", "icon.icns"));
  });
});
