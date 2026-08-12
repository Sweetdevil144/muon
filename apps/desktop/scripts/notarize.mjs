/**
 * notarize.mjs, electron-builder `afterSign` hook.
 *
 * CERT-GATED AND OFF. MUON ships unsigned today, so this NO-OPS unless real
 * Apple credentials are present. Enabling the signed lane also requires an
 * intentional release-config change and a verified two-version upgrade:
 *
 *   1. Provide a signing identity so electron-builder actually signs:
 *        export CSC_IDENTITY_AUTO_DISCOVERY=true
 *        # and a "Developer ID Application" cert in the login keychain
 *        # (or CSC_LINK=<base64 .p12> + CSC_KEY_PASSWORD=<pw>)
 *      …and set `mac.identity` in electron-builder.yml to that identity (remove
 *      `identity: null`). Notarization requires a Developer-ID SIGNATURE first;
 *      an ad-hoc-signed (unsigned) app cannot be notarized.
 *
 *   2. Provide notarization credentials (any ONE set):
 *        APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID   (Apple ID)
 *        APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER      (App Store Connect API key)
 *
 * When neither credential set is present it prints why and returns, the
 * explicitly unsigned build proceeds. Once credentials are supplied, every
 * missing prerequisite fails the build closed.
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
export default async function notarize(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  if (electronPlatformName !== "darwin") {
    return;
  }

  const appleIdKeys = [
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ];
  const apiKeyKeys = [
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ];
  const present = (key) => Boolean(process.env[key]?.trim());
  const appleIdCount = appleIdKeys.filter(present).length;
  const apiKeyCount = apiKeyKeys.filter(present).length;
  const hasAppleId = appleIdCount === appleIdKeys.length;
  const hasApiKey = apiKeyCount === apiKeyKeys.length;
  const configuredIdentity =
    packager.platformSpecificBuildOptions?.identity?.trim();
  const signingIntent =
    Boolean(configuredIdentity && configuredIdentity !== "-") ||
    present("CSC_LINK") ||
    present("CSC_KEY_PASSWORD") ||
    present("CSC_NAME") ||
    process.env.CSC_IDENTITY_AUTO_DISCOVERY?.trim().toLowerCase() === "true";

  if (
    (appleIdCount > 0 && !hasAppleId) ||
    (apiKeyCount > 0 && !hasApiKey)
  ) {
    throw new Error(
      "[notarize] incomplete Apple credentials: provide every variable in one complete set " +
        "(APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID or " +
        "APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER)."
    );
  }
  if (signingIntent && !hasAppleId && !hasApiKey) {
    throw new Error(
      "[notarize] signing credentials are present without a complete notarization credentials set."
    );
  }

  if (!hasAppleId && !hasApiKey) {
    console.log(
      "[notarize] skipped, no Apple credentials in env (unsigned build). " +
        "Set APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID (or APPLE_API_KEY/" +
        "APPLE_API_KEY_ID/APPLE_API_ISSUER) + a signing identity to enable."
    );
    return;
  }

  // Only import @electron/notarize when we actually intend to notarize, so an
  // unsigned build has no hard dependency on it being installed.
  let notarizeFn;
  try {
    ({ notarize: notarizeFn } = await import("@electron/notarize"));
  } catch (error) {
    throw new Error(
      "[notarize] Apple credentials are set but @electron/notarize is not installed. " +
        "Run `npm i -D @electron/notarize` in apps/desktop, then rebuild.",
      { cause: error }
    );
  }

  const appName = packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  const appBundleId = packager.appInfo.id; // dev.muonlabs.muon

  console.log(`[notarize] notarizing ${appPath} …`);

  const credentials = hasApiKey
    ? {
        appleApiKey: process.env.APPLE_API_KEY,
        appleApiKeyId: process.env.APPLE_API_KEY_ID,
        appleApiIssuer: process.env.APPLE_API_ISSUER,
      }
    : {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      };

  await notarizeFn({
    appBundleId,
    appPath,
    ...credentials,
  });

  console.log("[notarize] done, stapling handled by electron-builder.");
}
