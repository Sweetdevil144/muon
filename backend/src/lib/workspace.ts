import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── P3-B: workspacePath validation (audit M2) ────────────────────────────────
//
// A `workspacePath` submitted on POST /api/dispatch or POST /api/tasks flows,
// unchanged, to a child-process `cwd` (the coding-agent CLI + the check-runner)
// and to a run-scoped config-write base (base-lane-adapter). Unvalidated, a
// token-holder could aim agents and the check-runner at ANY directory on disk
// (traversal, absolute escape, or a symlink that resolves outside a repo). This
// module constrains a submitted path to an allowlisted set of roots, resolving
// symlinks so an escape cannot be smuggled through a link inside an allowed root.
//
// The allowlist is intentionally permissive for normal local use, the process
// CWD and the user's home subtree are always allowed, and widenable for power
// users / CI via MUON_WORKSPACE_ROOTS (comma-separated absolute or ~-relative
// roots). It is NOT isolation: running an untrusted repo's own checks is still
// host code-execution (that is the S1 sandbox; see docs/adr/0008).

/** Expand a leading `~` / `~/…` to the user's home directory. */
function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/** realpath a path that is expected to exist (a root); fall back to itself. */
function realpathSafe(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Resolve `target` to a real path even when its deepest segments do not exist
 * yet (a workspace dir may be created by the run). Walks up to the nearest
 * existing ancestor, resolves ITS symlinks, then re-appends the missing tail,
 * so a symlink anywhere along the existing prefix is followed and cannot hide
 * an escape.
 */
export function realpathOfNearestExisting(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without an existing component.
        return path.resolve(target);
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `target` is `root` itself or lives underneath it. */
export function isWithin(root: string, target: string): boolean {
  if (target === root) {
    return true;
  }
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(rootWithSep);
}

/**
 * The allowlisted roots a `workspacePath` may resolve under. Union of: the
 * configured MUON_WORKSPACE_ROOTS (comma-separated; widens for CI / power
 * users), the process CWD, and the user's home directory. Configured roots ADD
 * to the defaults, a repo under home always works out of the box.
 */
export function workspaceRoots(
  env: NodeJS.ProcessEnv = process.env
): string[] {
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
  roots.add(path.resolve(process.cwd()));
  roots.add(path.resolve(os.homedir()));
  return [...roots];
}

export type WorkspaceValidation =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Validate a submitted `workspacePath`. Resolves `~`, normalizes `..`, follows
 * symlinks on the existing prefix, and requires the result to sit within one of
 * {@link workspaceRoots}. Returns the normalized absolute path on success, or a
 * human-readable reason on rejection (the route turns that into a 400).
 */
export function validateWorkspacePath(
  input: string,
  opts: { roots?: string[]; env?: NodeJS.ProcessEnv } = {}
): WorkspaceValidation {
  const roots = opts.roots ?? workspaceRoots(opts.env);
  const resolved = path.resolve(expandHome(input));
  const real = realpathOfNearestExisting(resolved);

  const contained = roots.some((root) =>
    isWithin(realpathSafe(path.resolve(root)), real)
  );
  if (!contained) {
    return {
      ok: false,
      reason:
        `workspacePath '${input}' resolves to '${real}', which is outside the allowed ` +
        `workspace roots (${roots.join(", ")}). Set MUON_WORKSPACE_ROOTS to widen the allowlist.`,
    };
  }
  return { ok: true, path: real };
}
