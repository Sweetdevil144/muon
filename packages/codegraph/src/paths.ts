import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Path helpers for CG-1, including THE canonicalization function that is the #1
 * correctness concern (ADR-0011 reviewer note 1). The pre-edit hero fuses the
 * provider's `BlastRadius.modules` by an EXACT string match against memory's
 * MODULE anchors (`preedit.ts:250` `exactSet.has(mod)` / the graph's
 * `list_contains(n.modules, $module)`). Those anchors are stored VERBATIM in the
 * namespace the caller supplied, and every real capture path (the ledger
 * fixtures `src/auth.ts`, `backend/src/lib/preedit.ts`, `package.json`) uses a
 * WORKSPACE-RELATIVE POSIX path: no leading `./`, no leading `/`, forward
 * slashes. So the provider MUST emit exactly that shape or fusion silently
 * yields zero matches. `toWorkspaceRelativePosix` is the single canonicalizer.
 */

/**
 * `SUPPORTED_EXTENSIONS` / `isSupportedSourceFile` now live on the TS adapter
 * (ADR-0016 §4, the extension gate is a language-specific concern) and are
 * RE-EXPORTED here for back-compat, so every historic `paths.ts` import site keeps
 * working. The F-1 canonicalizer + id algebra below stay SHARED and untouched.
 */
export {
  SUPPORTED_EXTENSIONS,
  isSupportedSourceFile,
} from "./adapters/typescript.js";

/** Probe order for extensionless / directory-index (barrel) resolution. */
export const PROBE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

/** Directories never scanned: build outputs, VCS, deps, caches. `node_modules`
 *  is dropped both here (never walked) and in the resolver (never an edge). */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  ".muon",
  ".turbo",
  ".cache",
  ".vercel",
  ".output",
]);

/**
 * SYMBOL IDENTITY (ADR-0012), the trivial `<module>#<name>` join/split, mirrored
 * here from `@muon/graph/symbol-id.ts` so CG-1 stays NATIVE-DEP-FREE (importing
 * the `@muon/graph` barrel would transitively load LadybugDB's native addon,
 * violating ADR-0011/0012's no-native-deps invariant). The load-bearing namespace
 * correctness lives in the SINGLE `toWorkspaceRelativePosix` canonicalizer above,
 * which produces the module prefix; these two are pure string ops. Byte-identity
 * with the graph copy, INCLUDING the `#`-in-module decline below, is pinned by a
 * cross-package shared-fixture identity test (backend/tests) + the round-trip E2E.
 */
export function toSymbolId(module: string, name: string): string | null {
  // A module path containing `#` (a legal POSIX filename char AND our delimiter)
  // cannot form a well-formed id → DECLINE; the file degrades to MODULE-level.
  if (module.includes("#")) {
    return null;
  }
  return `${module}#${name}`;
}

/** The module PREFIX of a symbol id, everything before the FIRST `#` (a value
 *  with no `#` passes through unchanged, so a module-only target degrades). */
export function moduleOfSymbol(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}

/** Union the module prefixes of a set of symbol ids (deduped, order-preserving),
 *  mirrored byte-for-byte from `@muon/graph/symbol-id.ts` so CG-1 stays
 *  NATIVE-DEP-FREE (the `@muon/graph` barrel transitively loads LadybugDB's native
 *  addon). Backs the provider's NEVER-WIDEN safety filter (ADR-0015 §3(f) / gate 2):
 *  a symbol-level referencer must derive a module already in the module closure. */
export function deriveModulesFromSymbols(symbols: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const symbol of symbols) {
    const mod = moduleOfSymbol(symbol);
    if (mod && !seen.has(mod)) {
      seen.add(mod);
      out.push(mod);
    }
  }
  return out;
}

/**
 * THE canonicalization function (ADR-0011 #1 risk). Map an absolute file path
 * to the memory-anchor namespace: a WORKSPACE-RELATIVE POSIX path with no
 * leading `./` and no leading `/` (e.g. `<root>/src/a.ts` → `src/a.ts`). This is
 * exactly what the hero's exact-string module fusion matches against.
 *
 * SELF-GUARDING (F-6): returns `null` when the file is NOT strictly inside
 * `root`, i.e. the relative path would escape upward (`..`) or is absolute
 * (different drive / outside). A non-canonical anchor (an `../…` or absolute
 * path) can therefore NEVER be emitted regardless of caller, belt-and-suspenders
 * for the F-1 namespace invariant. The provider filters nulls out.
 */
export function toWorkspaceRelativePosix(
  root: string,
  absFile: string
): string | null {
  const rel = path.relative(root, absFile);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join("/");
}

/** True when `target` is `root` itself or lives underneath it (path-segment safe). */
export function isWithin(root: string, target: string): boolean {
  if (target === root) {
    return true;
  }
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(withSep);
}

/** realpath a path that is expected to exist; fall back to itself on failure. */
function realpathSafe(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * The DEFAULT P3-B-style allowlist, used when the backend does not inject the
 * canonical `validateWorkspacePath`. Mirrors `backend/src/lib/workspace.ts`
 * semantics: a root is allowed only when it (realpath'd) sits within the process
 * CWD, the user's home subtree, or a `MUON_WORKSPACE_ROOTS` entry. The backend
 * OVERRIDES this with the verbatim P3-B validator; this keeps the provider
 * safe-by-construction if constructed standalone.
 */
export function isRootAllowed(
  root: string,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): boolean {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const roots = new Set<string>();
  const configured = env.MUON_WORKSPACE_ROOTS;
  if (configured) {
    for (const raw of configured.split(",")) {
      const trimmed = raw.trim();
      if (trimmed) {
        roots.add(path.resolve(expandHome(trimmed)));
      }
    }
  }
  roots.add(path.resolve(cwd));
  roots.add(path.resolve(os.homedir()));
  const real = realpathSafe(path.resolve(root));
  return [...roots].some((allowed) =>
    isWithin(realpathSafe(path.resolve(allowed)), real)
  );
}
