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

/** Host-side alias commands to run after all uploads verify.
 *
 *  HARDLINK, not `cp` (2026-08-19): the alias used to be a full second copy,
 *  which on a 4.6G volume holding ~640MB dmgs is a release-sized cost — the
 *  0.4.8 publish would not have fit beside 0.3.2 + 0.4.7 with a copied alias.
 *  `ln -f` serves the identical bytes at zero extra blocks, and re-pointing it
 *  on the next release frees the old alias automatically. Versioned artifacts
 *  are immutable once uploaded, so the shared inode can never drift. */
export function aliasCommands(version) {
  return releaseArtifacts(version)
    .filter((a) => a.alias)
    .map((a) => `ln -f /data/${a.name} /data/${a.alias}`);
}


// ---------------------------------------------------------------------------
// Founder policy (2026-08-20): every release SNAPSHOTS the live release,
// PRUNES everything else, uploads, verifies, and only then retires the old
// live release's served names — so the volume ends each release holding
// exactly the new release plus one rollback snapshot, and a failed publish
// rolls back instead of stranding a broken feed.
// ---------------------------------------------------------------------------

/** The three files uploads REWRITE IN PLACE (`cat > /data/<name>`). These are
 *  `cp`'d into the snapshot, never hardlinked: truncating a shared inode
 *  would corrupt the snapshot's copy at the exact moment it becomes the only
 *  rollback. Versioned artifacts are write-once names, so hardlinks are safe
 *  (and free) for them. */
export const FEED_FILES = ["latest-mac.yml", "latest-cli.json", "SHA256SUMS"];

/** Versioned artifact names for a release (no feeds, no aliases). */
export function versionedArtifactNames(version) {
  return releaseArtifacts(version)
    .filter((a) => !FEED_FILES.includes(a.name))
    .map((a) => a.name);
}

/** Snapshot the LIVE release into /data/.rollback/<v>. Exactly ONE rollback
 *  is kept — the previous snapshot dies here, by design. Tolerant of missing
 *  members (a blockmap that never uploaded must not abort a snapshot). */
export function snapshotCommands(liveVersion) {
  const dir = `/data/.rollback/${liveVersion}`;
  const links = versionedArtifactNames(liveVersion)
    .map((n) => `[ -e "/data/${n}" ] && ln -f "/data/${n}" "${dir}/${n}"`)
    .join("; ");
  const copies = FEED_FILES.map(
    (n) => `[ -e "/data/${n}" ] && cp "/data/${n}" "${dir}/${n}"`
  ).join("; ");
  return [
    `rm -rf /data/.rollback && mkdir -p ${dir}`,
    `${links}; true`,
    `${copies}; true`,
  ];
}

/** Remove every top-level release artifact belonging to NEITHER of the two
 *  named versions. Aliases and feeds are excluded by name; anything else
 *  matching the artifact globs is a stray from an older release. Pass the
 *  same version twice for the post-verify prune (only the new release
 *  survives). */
export function pruneCommands(keepA, keepB = keepA) {
  const keep = [
    ...versionedArtifactNames(keepA),
    ...(keepB === keepA ? [] : versionedArtifactNames(keepB)),
    "MUON-latest-arm64.dmg",
    "muon-cli-latest.tgz",
  ];
  const keepCase = keep.map((n) => `"${n}"`).join("|");
  return [
    `for f in /data/MUON-*.dmg /data/MUON-*.zip /data/MUON-*.blockmap /data/muon-cli-*.tgz; do [ -e "$f" ] || continue; case "$(basename "$f")" in ${keepCase}) ;; *) rm -f "$f" ;; esac; done; true`,
  ];
}

/** Restore the live channel from /data/.rollback/<v>: artifact names come
 *  back as hardlinks (same bytes), feeds as copies. Safe to run repeatedly. */
export function rollbackCommands(liveVersion) {
  const dir = `/data/.rollback/${liveVersion}`;
  const links = versionedArtifactNames(liveVersion)
    .map((n) => `[ -e "${dir}/${n}" ] && ln -f "${dir}/${n}" "/data/${n}"`)
    .join("; ");
  const copies = FEED_FILES.map(
    (n) => `[ -e "${dir}/${n}" ] && cp "${dir}/${n}" "/data/${n}"`
  ).join("; ");
  const aliases = [
    `[ -e "${dir}/MUON-${liveVersion}-arm64.dmg" ] && ln -f "${dir}/MUON-${liveVersion}-arm64.dmg" /data/MUON-latest-arm64.dmg`,
    `[ -e "${dir}/muon-cli-${liveVersion}.tgz" ] && ln -f "${dir}/muon-cli-${liveVersion}.tgz" /data/muon-cli-latest.tgz`,
  ].join("; ");
  return [`${links}; true`, `${copies}; true`, `${aliases}; true`];
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
