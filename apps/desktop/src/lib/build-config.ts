import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Release coordinates BAKED at package time.
 *
 * A packaged app launched from Finder inherits launchd's environment, not a
 * shell's — `process.env.MUON_GITHUB_CLIENT_ID` is EMPTY there, so the
 * identity gate silently self-disabled on every consumer install and logged
 * a "RELEASE DEFECT" the consumer never sees. The client id is not a secret
 * (the device flow needs no client secret; the id is public by design), so it
 * ships as a plain JSON file beside the app:
 * `scripts/write-build-config.mjs` writes `staged/build-config.json` from the
 * packager's env, electron-builder's extraResources copies staged/* into
 * `<Resources>/`, and this module reads it back at boot.
 *
 * Precedence stays env-first: a developer's or tester's explicit env var
 * always wins over the baked value, and an UNPACKAGED run never reads any
 * baked file at all — dev behavior is byte-identical.
 */
export type BakedBuildConfig = {
  githubClientId?: string;
};

export function readBakedBuildConfig(input: {
  isPackaged: boolean;
  resourcesPath: string;
}): BakedBuildConfig {
  if (!input.isPackaged) return {};
  try {
    const raw = readFileSync(
      join(input.resourcesPath, "build-config.json"),
      "utf8"
    );
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const clientId = (parsed as { githubClientId?: unknown }).githubClientId;
    return typeof clientId === "string" && clientId.trim().length > 0
      ? { githubClientId: clientId.trim() }
      : {};
  } catch {
    // Absent or unreadable file = an unbaked build; the gate's existing
    // misconfiguration logging (github-gate.ts) is the surface that reports it.
    return {};
  }
}

/**
 * Boot-time env hydration, called ONCE before anything computes gate policy.
 * Mutating process.env is deliberate: the gate, the settings status read, and
 * the brain child (spawned with `...process.env`) must all see ONE value, and
 * hydrating the single source they already read beats threading a second
 * coordinate through three consumers.
 */
export function hydrateBakedEnv(
  env: NodeJS.ProcessEnv,
  baked: BakedBuildConfig
): void {
  if (!env.MUON_GITHUB_CLIENT_ID?.trim() && baked.githubClientId) {
    env.MUON_GITHUB_CLIENT_ID = baked.githubClientId;
  }
}
