/**
 * H10 — the renderer-safe route to the ONE session-slug projection.
 *
 * The function itself lives in `@muon/protocol` (with the id it projects), and
 * every non-browser surface imports it from there. The desktop renderer can
 * reach neither of the obvious alternatives: `@muon/protocol` is not a desktop
 * dependency and does not resolve for the esbuild browser bundle AT ALL, and
 * the `@muon/client` barrel drags index → paths → `node:fs`, which esbuild
 * cannot bundle for a browser target. So this pure, dependency-free subpath
 * re-exports it — exactly the shape `./crew-liveness` already uses for
 * `withoutBudgetMarker`, and for the same reason.
 *
 * Deliberately a re-export and NOT a copy: a second implementation is how the
 * rail and the TUI strip would start calling the same job two different names,
 * which is the precise failure H10 exists to prevent.
 */
export { sessionSlug, sessionSlugLine } from "@muon/protocol";
