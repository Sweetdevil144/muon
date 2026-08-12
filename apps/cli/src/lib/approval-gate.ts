// Moved to @muon/client so every surface (CLI, TUI, desktop runner) gates
// work through the same fail-closed logic. Re-exported here for back-compat.
export {
  waitForApproval,
  type WaitForApprovalOptions,
} from "@muon/client";
