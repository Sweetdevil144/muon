import fs from "node:fs";
import path from "node:path";
import { PROBE_EXTENSIONS, isWithin } from "./paths.js";

/**
 * The RESOLVER, hand-rolled, zero native deps (ADR-0011 Decision 2). Maps an
 * import specifier (from the scanner) to the intra-repo file it resolves to, or
 * `null` when it is external / unresolvable. Covers:
 *
 *   - RELATIVE specifiers (`./x`, `../y`) against the importing file's dir.
 *   - EXTENSION probing (`.ts,.tsx,.mts,.cts,.d.ts,.js,.jsx,.mjs,.cjs`).
 *   - The NodeNext ESM convention where a `"./x.js"` specifier maps to `x.ts`.
 *   - `index.*` / BARREL directory resolution.
 *   - tsconfig `paths` aliases + `baseUrl`-relative bare imports.
 *
 * BARE `node_modules` specifiers (and anything that resolves through a
 * `node_modules` segment or outside the repo root) are DROPPED, only intra-repo
 * edges matter for a blast-radius. Under-inclusion here is SAFE (fewer
 * neighbours, never wrong governance, ADR-0011 Risks).
 */

export type TsconfigPaths = {
  /** Absolute base dir for `paths`/bare resolution (defaults to the repo root). */
  baseUrl: string;
  /** The tsconfig `compilerOptions.paths` map (patterns → target templates). */
  paths: Record<string, string[]>;
};

export type Resolver = {
  /** Resolve `specifier` imported from `fromFile` to an absolute in-repo file, or null. */
  resolve(fromFile: string, specifier: string): string | null;
};

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * F-5 guard: does `specifier`'s package name resolve to an INSTALLED package
 * under `<root>/node_modules`? If so, a coincidental in-root `baseUrl` file of
 * the same name must NOT shadow it (that would fabricate a wrong intra-repo
 * edge). Handles `@scope/name` and `name/deep/path`.
 */
function looksLikeInstalledPackage(root: string, specifier: string): boolean {
  const parts = specifier.split("/");
  const pkg = specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0];
  if (!pkg) {
    return false;
  }
  return exists(path.join(root, "node_modules", pkg));
}

/** NodeNext: a `.js`-family specifier commonly denotes a `.ts`-family source. */
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/** Probe a base path for a real source file: exact, ext-swapped, extensionless, or dir index. */
function probe(basePath: string): string | null {
  if (isFile(basePath)) {
    return basePath;
  }
  const ext = path.extname(basePath);
  const swaps = JS_TO_TS[ext];
  if (swaps) {
    const stem = basePath.slice(0, basePath.length - ext.length);
    for (const candidate of swaps) {
      if (isFile(stem + candidate)) {
        return stem + candidate;
      }
    }
  }
  for (const probeExt of PROBE_EXTENSIONS) {
    if (isFile(basePath + probeExt)) {
      return basePath + probeExt;
    }
  }
  if (isDir(basePath)) {
    for (const probeExt of PROBE_EXTENSIONS) {
      const index = path.join(basePath, `index${probeExt}`);
      if (isFile(index)) {
        return index;
      }
    }
  }
  return null;
}

/** Expand a bare specifier through tsconfig `paths` patterns; probe each target. */
function resolveViaTsPaths(
  tsconfig: TsconfigPaths,
  specifier: string
): string | null {
  for (const [pattern, targets] of Object.entries(tsconfig.paths)) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (pattern !== specifier) {
        continue;
      }
      for (const target of targets) {
        const hit = probe(path.resolve(tsconfig.baseUrl, target));
        if (hit) {
          return hit;
        }
      }
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      specifier.length < prefix.length + suffix.length ||
      !specifier.startsWith(prefix) ||
      !specifier.endsWith(suffix)
    ) {
      continue;
    }
    const matched = specifier.slice(
      prefix.length,
      specifier.length - suffix.length
    );
    for (const target of targets) {
      const expanded = target.includes("*")
        ? target.replace("*", matched)
        : target;
      const hit = probe(path.resolve(tsconfig.baseUrl, expanded));
      if (hit) {
        return hit;
      }
    }
  }
  return null;
}

export function createResolver(opts: {
  root: string;
  tsconfig?: TsconfigPaths | null;
}): Resolver {
  const root = path.resolve(opts.root);
  const tsconfig = opts.tsconfig ?? null;

  /** Constrain a probe hit to an intra-repo, non-`node_modules` file. */
  function finalize(hit: string | null): string | null {
    if (!hit) {
      return null;
    }
    const resolved = path.resolve(hit);
    if (resolved.split(path.sep).includes("node_modules")) {
      return null;
    }
    if (!isWithin(root, resolved)) {
      return null;
    }
    return resolved;
  }

  return {
    resolve(fromFile: string, specifier: string): string | null {
      if (!specifier) {
        return null;
      }
      // Relative specifier → resolve against the importing file's directory.
      if (specifier.startsWith(".")) {
        return finalize(probe(path.resolve(path.dirname(fromFile), specifier)));
      }
      // Absolute path specifier (rare) → probe directly, still constrained to root.
      if (path.isAbsolute(specifier)) {
        return finalize(probe(specifier));
      }
      // Bare specifier → tsconfig paths / baseUrl, else external (node_modules) → drop.
      if (tsconfig) {
        // Explicit `paths` aliases WIN (intentional cross-package edges).
        const viaPaths = resolveViaTsPaths(tsconfig, specifier);
        if (viaPaths) {
          return finalize(viaPaths);
        }
        // F-5: never let a baseUrl-relative in-root file shadow an actually
        // installed node_modules package of the same name.
        if (looksLikeInstalledPackage(root, specifier)) {
          return null;
        }
        const viaBase = probe(path.resolve(tsconfig.baseUrl, specifier));
        if (viaBase) {
          return finalize(viaBase);
        }
      }
      return null;
    },
  };
}
