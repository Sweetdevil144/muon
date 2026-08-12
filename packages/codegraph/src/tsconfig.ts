import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { TsconfigPaths } from "./resolver.js";

/**
 * Load the repo-root tsconfig's `baseUrl`/`paths` for monorepo alias resolution
 * (ADR-0011 Decision 2). Uses `ts.parseConfigFileTextToJson` (tolerates comments
 * + trailing commas, no `Program`, no typecheck). Returns `null` when there is
 * no tsconfig or it declares neither `baseUrl` nor `paths`.
 *
 * LIMITATION (documented residual): `extends` chains and nested project
 * references are NOT followed in v1, a missed alias causes UNDER-inclusion
 * (fewer neighbours), which is safe (never wrong governance).
 */
export function loadTsconfigPaths(root: string): TsconfigPaths | null {
  const file = path.join(root, "tsconfig.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const parsed = ts.parseConfigFileTextToJson(file, text);
  if (parsed.error || !parsed.config) {
    return null;
  }
  const compilerOptions = (parsed.config.compilerOptions ?? {}) as {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
  const paths = compilerOptions.paths ?? {};
  const hasPaths = Object.keys(paths).length > 0;
  if (!compilerOptions.baseUrl && !hasPaths) {
    return null;
  }
  // Modern TS allows `paths` with no `baseUrl` (patterns are relative to the
  // tsconfig dir). An explicit `baseUrl` is resolved against the repo root.
  const baseUrl = compilerOptions.baseUrl
    ? path.resolve(root, compilerOptions.baseUrl)
    : root;
  return { baseUrl, paths };
}
