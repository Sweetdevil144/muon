import { existsSync } from "node:fs";
import path from "node:path";

export type DesktopRunnerConfig = {
  apiBase: string;
  agentToken?: string;
  host: string;
  leaseToken: string;
};

export type RunnerEntry = {
  path: string;
  kind: "desktop" | "legacy-cli";
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Read the dedicated runner's non-interactive config from its hygienic env. */
export function readDesktopRunnerConfig(
  env: NodeJS.ProcessEnv = process.env
): DesktopRunnerConfig {
  const rawBase = env.MUON_API_BASE?.trim();
  if (!rawBase) {
    throw new Error("MUON_API_BASE is required for the desktop runner");
  }
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    throw new Error("MUON_API_BASE must be a valid loopback URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname)
  ) {
    throw new Error("MUON_API_BASE must use http(s) on loopback");
  }

  const host = env.MUON_RUNNER_HOST?.trim();
  if (!host) {
    throw new Error("MUON_RUNNER_HOST is required for the desktop runner");
  }
  if (host.length > 200) {
    throw new Error("MUON_RUNNER_HOST must be at most 200 characters");
  }
  const leaseToken = env.MUON_RUNNER_LEASE_TOKEN?.trim();
  if (!leaseToken || leaseToken.length < 32 || leaseToken.length > 512) {
    throw new Error(
      "MUON_RUNNER_LEASE_TOKEN must contain 32–512 characters for the desktop runner"
    );
  }
  const agentToken = env.MUON_AGENT_TOKEN?.trim() || undefined;
  return {
    apiBase: url.toString().replace(/\/$/, ""),
    agentToken,
    host,
    leaseToken,
  };
}

export type ResolveRunnerEntryOptions = {
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  moduleDir?: string;
  exists?: (candidate: string) => boolean;
};

/**
 * Resolve the self-contained desktop entry first, retaining the old CLI entry
 * only as a compatibility fallback for development installs.
 */
export function resolveRunnerEntry(
  options: ResolveRunnerEntryOptions = {}
): RunnerEntry | undefined {
  const env = options.env ?? process.env;
  const runtimeResourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath;
  const resourcesPath = options.resourcesPath ?? runtimeResourcesPath ?? "";
  const moduleDir = options.moduleDir ?? __dirname;
  const exists = options.exists ?? existsSync;

  const override = env.MUON_RUNNER_ENTRY?.trim();
  if (override && exists(override)) {
    return { path: override, kind: "desktop" };
  }

  const desktopCandidates = [
    path.join(resourcesPath, "app.asar", "dist", "runner-entry.js"),
    path.join(resourcesPath, "app.asar.unpacked", "dist", "runner-entry.js"),
    path.resolve(moduleDir, "..", "runner-entry.js"),
  ];
  for (const candidate of desktopCandidates) {
    if (candidate && exists(candidate)) {
      return { path: candidate, kind: "desktop" };
    }
  }

  const legacyOverride = env.MUON_CLI_ENTRY?.trim();
  if (legacyOverride && exists(legacyOverride)) {
    return { path: legacyOverride, kind: "legacy-cli" };
  }

  const packagedLegacyCandidates = [
    path.join(resourcesPath, "apps", "cli", "dist", "index.js"),
    path.join(
      resourcesPath,
      "app.asar.unpacked",
      "apps",
      "cli",
      "dist",
      "index.js"
    ),
  ];
  for (const candidate of packagedLegacyCandidates) {
    if (candidate && exists(candidate)) {
      return { path: candidate, kind: "legacy-cli" };
    }
  }

  let dir = moduleDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "apps", "cli", "dist", "index.js");
    if (exists(candidate)) {
      return { path: candidate, kind: "legacy-cli" };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
