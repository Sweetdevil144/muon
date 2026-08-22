// The embedded-brain bootstrap now lives in `@muon/client` (node-only entry,
// beside paths.ts) so every local human surface — the CLI here and the TUI —
// shares ONE spawn/probe implementation. This shim keeps the CLI's import site
// (`apps/cli/src/index.ts`) byte-identical.
export {
  ensureBrain,
  type EnsureBrainResult,
} from "@muon/client/ensure-brain";

import { ensureBrain as ensureBrainImpl } from "@muon/client/ensure-brain";

/**
 * THE brain-start policy, shared by the root preAction hook and the guided
 * setup wizard (which is brain-exempt for the scripted path's sake and must
 * therefore make this decision itself before its brain-backed steps). One
 * function so the two cannot drift: an explicit base means the brain is
 * elsewhere and starting a local one would be wrong; otherwise ensure it,
 * and surface the note without failing the command.
 */
export async function ensureBrainUnlessExplicitBase(
  apiBaseFlag: string | undefined
): Promise<{ live: boolean }> {
  const explicitBase =
    apiBaseFlag?.trim() ||
    process.env.MUON_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_MUON_API_BASE?.trim();
  // An explicit base means a brain is already THERE; "live" for the caller's
  // purposes (the hook's human-present note goes to that brain via the client).
  if (explicitBase) return { live: true };
  const result = await ensureBrainImpl();
  if (!result.live && result.note) {
    process.stderr.write(`muon: ${result.note}\n`);
  }
  return { live: result.live };
}
