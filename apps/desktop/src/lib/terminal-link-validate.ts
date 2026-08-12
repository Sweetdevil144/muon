import path from "node:path";

/**
 * ROADMAP T4 — trusted MAIN's independent re-check of an OSC-8 hyperlink
 * target the renderer already classified (`renderer/lib/terminal-link-
 * security.ts`). Deliberately a SEPARATE implementation rather than a shared
 * import: main and the renderer compile under different TypeScript projects
 * (`tsconfig.json` excludes `src/renderer` outright, and the renderer bundles
 * separately with esbuild), so this small allowlist is restated here rather
 * than reached for across that boundary — the same posture `github-review.ts`
 * takes for its own external-URL allowlist.
 *
 * THIS is the check that actually matters: the renderer is untrusted, full
 * stop, so its own classification is only ever a UX nicety (deciding whether
 * to underline a link at all). The real gate is here, immediately before
 * `shell.openExternal` / a Finder reveal in `main.ts`'s `muon:openTerminalLink`
 * handler.
 */

const ALLOWED_URL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

export function isAllowedTerminalLinkUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ALLOWED_URL_PROTOCOLS.has(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/**
 * Is `candidate` inside `workspaceRoot`? Both are resolved through
 * `path.resolve` (which collapses `..`/`.` and requires an absolute base), so
 * a traversal segment cannot walk outside the root; the boundary check is a
 * real path-segment prefix (`root` or `root/…`), not a bare string prefix —
 * `/workspace-evil` must never pass a check against `/workspace`.
 */
export function isWithinWorkspaceRoot(
  candidate: string,
  workspaceRoot: string
): boolean {
  if (!path.isAbsolute(candidate) || !path.isAbsolute(workspaceRoot)) {
    return false;
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}
