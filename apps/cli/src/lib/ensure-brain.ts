// The embedded-brain bootstrap now lives in `@muon/client` (node-only entry,
// beside paths.ts) so every local human surface — the CLI here and the TUI —
// shares ONE spawn/probe implementation. This shim keeps the CLI's import site
// (`apps/cli/src/index.ts`) byte-identical.
export {
  ensureBrain,
  type EnsureBrainResult,
} from "@muon/client/ensure-brain";
