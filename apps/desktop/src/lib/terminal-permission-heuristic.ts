import {
  BUNDLED_DETECTION_MANIFEST,
  detectionPatternsFor,
  matchesPermissionPrompt,
  readDetectionManifest,
  type DetectionManifest,
} from "@muon/client/detection-manifest";

/**
 * ROADMAP T2 — a DISPLAY-ONLY heuristic for "this human terminal tab's own
 * vendor CLI looks like it just printed a permission/confirmation prompt". It
 * exists to feed one extra `PaneDisplayStatus` dot (`permission` —
 * pane-status.ts) on tabs the plain activity timeout cannot otherwise tell
 * apart from `working`; it is not, and must never become, an approval
 * mechanism:
 *
 * - There is no channel back into a human's own interactive vendor session
 *   (ADR-0025 §2) — nothing here could answer a prompt even if it tried.
 * - Matching is deliberately NARROW. A false negative just leaves the dot at
 *   `working`/`idle`; a false positive draws an attention dot over ordinary
 *   output. Both are cosmetic — this is display data over an untrusted byte
 *   stream — but narrow-and-occasionally-wrong is the safer default for a
 *   signal nobody should ever come to rely on.
 * - This is the thin slice. Per-vendor lifecycle hooks/wrappers that emit a
 *   structured "I am waiting on you" event instead of pattern-matching raw
 *   bytes remain the fuller path ROADMAP T2 still names.
 *
 * ADR-0039 (feature #13) moved the patterns OUT of this file. They were eight
 * regexes compiled into the app, so a vendor rewording its prompt silently
 * killed the dot until someone shipped a MUON release — the regex-rot class.
 * They now live in a versioned manifest a user can override without a release,
 * and they are literal substrings rather than regexes, because a
 * hot-reloadable regex matched against untrusted vendor output is a
 * backtracking DoS aimed at this very render path.
 */

/**
 * Only the tail of accumulated output is examined — a prompt is a RECENT
 * thing, and matching against unbounded scrollback would eventually hit
 * something from minutes-old output that has long since scrolled past and
 * been answered.
 */
export const PERMISSION_HEURISTIC_WINDOW_CHARS = 4000;

/**
 * The manifest currently in force. Starts as the compiled fallback, so the
 * renderer behaves exactly as it did before this feature until a local
 * override is successfully installed.
 *
 * Module-level because the desktop has one renderer per window and this is
 * display data; it is deliberately NOT reachable by anything that decides
 * authority (ADR-0039 D1 — a manifest describes, it never permits).
 */
let activeManifest: DetectionManifest = BUNDLED_DETECTION_MANIFEST;
let activeSource: "local" | "bundled" = "bundled";
let lastRefusal: string | undefined;

/**
 * Install a candidate manifest — the hot-reload entry point.
 *
 * Returns what happened so a caller can surface a refusal. ADR-0039 D3: a
 * manifest is applied whole or not at all, and any refusal leaves the previous
 * manifest untouched rather than dropping to a partial state.
 */
export function loadDetectionManifest(candidate: unknown): {
  source: "local" | "bundled";
  refused?: string;
} {
  const result = readDetectionManifest(candidate);
  if (result.refused) {
    // LEAVE the previous manifest in place. Assigning unconditionally meant a
    // user with a working local manifest who then typo'd an edit had their
    // patterns silently replaced by the bundled set on the next hot-reload —
    // a refusal that made things WORSE than not reloading, and the opposite of
    // what this docstring promised.
    lastRefusal = result.refused;
    return { source: activeSource, refused: result.refused };
  }
  activeManifest = result.manifest;
  activeSource = result.source;
  lastRefusal = undefined;
  return { source: result.source };
}

/** Why the last candidate manifest was rejected, if one was. */
export function detectionManifestRefusal(): string | undefined {
  return lastRefusal;
}

/** Restores the compiled fallback. Exists so tests cannot leak state. */
export function resetDetectionManifest(): void {
  activeManifest = BUNDLED_DETECTION_MANIFEST;
  activeSource = "bundled";
  lastRefusal = undefined;
}

export function looksLikePermissionPrompt(
  recentOutput: string,
  vendorId?: string | null
): boolean {
  const tail = recentOutput.slice(-PERMISSION_HEURISTIC_WINDOW_CHARS);
  return matchesPermissionPrompt(
    tail,
    detectionPatternsFor(activeManifest, vendorId)
  );
}
