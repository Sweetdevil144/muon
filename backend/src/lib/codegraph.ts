import { type CodeGraphProvider } from "@muon/graph";
import { validateWorkspacePath } from "./workspace.js";

/**
 * CG-1 selection gate (ADR-0012 Phase 0, ALWAYS-ON, founder directive). Returns
 * a MEMOIZED `LocalCodeGraphProvider`, the local, in-process, no-egress
 * reverse-import (+ symbol→module) blast-radius provider. There is NO enable flag
 * and NO off-switch: the only "off" is the provider's intrinsic DEGRADE-TO-NULL
 * (`provider.impact` → `null` on any doubt, unsupported language, unresolvable
 * target, over-budget scan, root outside the allowlist), which already yields
 * today's `target-only` byte-for-byte, so a hero call can never fail on the graph.
 *
 * The `LocalCodeGraphProvider` is wired with the CANONICAL P3-B allowlist
 * (`validateWorkspacePath`, `backend/src/lib/workspace.ts`) so it may only scan
 * roots the token-holder is already allowed to aim agents at. Its per-root index
 * cache lives on the singleton, so it survives across gate calls (single-writer
 * backend). A caller-supplied `opts.blastRadius` (orchestrator + GitNexus) still
 * SHORT-CIRCUITS the provider in `preEditContext`, CG-1 only fills the else-branch.
 *
 * DARK-LOAD-FREE BOOT PRESERVED (ADR-0012 Decision 6): `@muon/codegraph` (which
 * pulls in `typescript`) is loaded via a lazy `import()` on the FIRST gate call,
 * NOT at boot, so the always-on switch keeps boot cost identical; only the first
 * gate call pays the module load.
 */

let localSingleton: CodeGraphProvider | undefined;

export async function selectCodeGraphProvider(
  env: NodeJS.ProcessEnv = process.env
): Promise<CodeGraphProvider> {
  if (!localSingleton) {
    const { LocalCodeGraphProvider } = await import("@muon/codegraph");
    localSingleton = new LocalCodeGraphProvider({
      env,
      validateRoot: (root) => validateWorkspacePath(root).ok,
    });
  }
  return localSingleton;
}

/** Test seam: drop the memoized provider so a fresh construction is re-read. */
export function resetCodeGraphProvider(): void {
  localSingleton = undefined;
}
