import { createHash } from "node:crypto";
import { importItemEvidence, type ImportedItem } from "./compatibility-import.js";

/**
 * ADR-0038 D3 — the fingerprint a human's approval is bound to.
 *
 * A NODE-ONLY subpath, exactly like `project-setup`: `node:crypto` cannot be
 * aggregated into the protocol's browser-safe root, and the browser side never
 * needs this anyway — a renderer DISPLAYS a digest, it does not compute one.
 * The rules that go with it (what may be enabled, what a diff means, what
 * drift reads as) stay in `compatibility-enable.ts` where every surface can
 * import them.
 *
 * Computed over `importItemEvidence`, which is shape-only, sorted, and
 * excludes the source path — so a moved config file does not read as a changed
 * item, while a changed command, url, argument or credential-name does. That
 * asymmetry is the whole point: D3 disables an item whose fingerprint moved,
 * and disabling someone's server because they reorganised their dotfiles would
 * make the mechanism worse than useless.
 */
export function importItemDigest(item: ImportedItem): string {
  return `sha256:${createHash("sha256")
    .update(importItemEvidence(item))
    .digest("hex")}`;
}
