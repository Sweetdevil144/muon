/**
 * Pure planning logic for the release pipeline (scripts/release-pipeline.mjs).
 *
 * Kept side-effect free so the artifact contract — what a release MUST consist
 * of and how it lands on the download host — is unit-testable without builds,
 * ssh, or the network (tests/release-plan.test.ts).
 */

/** Every artifact a v-versioned macOS release publishes, in upload order.
 *  Small files first so an interrupted upload fails fast, the two large
 *  payloads last. `alias` names the stable-URL copy created ON the host after
 *  the upload verifies (aliases are host-side `cp`, never a second upload). */
export function releaseArtifacts(version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`not a semver version: ${version}`);
  }
  return [
    { name: "latest-mac.yml", from: "desktop" },
    { name: "SHA256SUMS", from: "generated" },
    // Read by `muon update` to learn what is published without downloading a
    // 400KB tarball just to inspect its package.json.
    { name: "latest-cli.json", from: "generated" },
    { name: `MUON-${version}-arm64.dmg.blockmap`, from: "desktop" },
    { name: `MUON-${version}-arm64-mac.zip.blockmap`, from: "desktop" },
    { name: `muon-cli-${version}.tgz`, from: "cli", alias: "muon-cli-latest.tgz" },
    { name: `MUON-${version}-arm64-mac.zip`, from: "desktop" },
    { name: `MUON-${version}-arm64.dmg`, from: "desktop", alias: "MUON-latest-arm64.dmg" },
  ];
}

/** The subset of artifacts SHA256SUMS covers — everything users can verify.
 *  Only the sums file itself is excluded, since it cannot checksum itself. */
export function checksummedArtifacts(version) {
  return releaseArtifacts(version)
    .filter((a) => a.name !== "SHA256SUMS")
    .map((a) => a.name);
}

/** Host-side alias commands to run after all uploads verify. */
export function aliasCommands(version) {
  return releaseArtifacts(version)
    .filter((a) => a.alias)
    .map((a) => `cp /data/${a.name} /data/${a.alias}`);
}

/** Public URLs that must answer 200 with the exact byte size after publish.
 *  `noCache` marks the ones the server must serve `cache-control: no-cache`
 *  (the feed and every `latest` alias — a stale CDN copy of those would pin
 *  users to an old release). */
export function publicChecks(version, base = "https://download.getmuon.com") {
  const checks = releaseArtifacts(version).map((a) => ({
    url: `${base}/${a.name}`,
    noCache: a.name === "latest-mac.yml",
  }));
  for (const a of releaseArtifacts(version)) {
    if (a.alias) {
      checks.push({ url: `${base}/${a.alias}`, noCache: true });
    }
  }
  return checks;
}

/** Parse `latest-mac.yml` far enough to assert it names this release's zip
 *  (guards against uploading a feed left over from a previous build dir). */
export function feedNamesVersion(feedText, version) {
  return (
    feedText.includes(`version: ${version}`) &&
    feedText.includes(`MUON-${version}-arm64-mac.zip`)
  );
}
