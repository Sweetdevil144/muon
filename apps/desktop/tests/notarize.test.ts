import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import notarize from "../scripts/notarize.mjs";

const context = {
  electronPlatformName: "darwin",
  appOutDir: "/tmp/MUON",
  packager: {
    appInfo: {
      productFilename: "MUON",
      id: "dev.muonlabs.muon",
    },
  },
} as never;

describe("notarize hook credential posture", () => {
  beforeEach(() => {
    for (const key of [
      "APPLE_ID",
      "APPLE_APP_SPECIFIC_PASSWORD",
      "APPLE_TEAM_ID",
      "APPLE_API_KEY",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "CSC_NAME",
      "CSC_IDENTITY_AUTO_DISCOVERY",
    ]) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed when any Apple credential set is only partially configured", async () => {
    vi.stubEnv("APPLE_ID", "release@example.com");

    await expect(notarize(context)).rejects.toThrow(/incomplete/i);
  });

  it("fails closed when signing intent is present without notarization credentials", async () => {
    vi.stubEnv("CSC_LINK", "base64-p12");

    await expect(notarize(context)).rejects.toThrow(/notarization credentials/i);
  });

  it("fails closed when electron-builder has a configured signing identity without notarization credentials", async () => {
    const signedContext = {
      ...context,
      packager: {
        ...context.packager,
        platformSpecificBuildOptions: {
          identity: "Developer ID Application: MUON Labs (TEAMID)",
        },
      },
    } as never;

    await expect(notarize(signedContext)).rejects.toThrow(
      /notarization credentials/i
    );
  });

  it("keeps the intentionally unsigned lane available when no credential variable is set", async () => {
    await expect(notarize(context)).resolves.toBeUndefined();
  });
});
