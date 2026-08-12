export * from "./build-handoff-packet.js";
export * from "./check-coverage.js";
export * from "./derived-checks.js";
export * from "./environment-attestation.js";
export * from "./event-recorder.js";
export * from "./handoff-evidence.js";
export * from "./harness.js";
export * from "./lane-doctor.js";
export * from "./loop-runner.js";
export * from "./loop-evaluator.js";
export * from "./memory-capture.js";
export * from "./memory-extract-lane.js";
export * from "./memory-slice.js";
export * from "./memory-window.js";
export * from "./muon-mcp-injection.js";
export * from "./plan-builder.js";
export * from "./planner.js";
export * from "./policy-simulate.js";
export * from "./port-association.js";
export * from "./port-scan.js";
export * from "./process-cwd.js";
export * from "./project-setup.js";
export * from "./role-assignment.js";
export * from "./run-lane-task.js";
export * from "./session-manager.js";
export * from "./stdin-stall.js";
export * from "./stream-recorder.js";
export * from "./worker-preamble.js";
export * from "./worker-final-report.js";
export * from "./workflow-runner.js";
export * from "./worktree.js";
export * from "./worktree-prep.js";
export type {
  HandoffPacket,
  LaneEvent,
  LaneEventKind,
} from "@muon/protocol";
// ADR-0013 #52, the vendor capability-descriptor registry + resolver live in
// @muon/adapters (the dispatch seam); surfaces that only depend on @muon/core
// (the ink TUI) reach the single-source descriptor through this re-export.
export {
  VENDOR_CAPABILITY_DESCRIPTORS,
  VENDOR_KEYS,
  PUBLIC_VENDOR_KEYS,
  VENDOR_LABELS,
  VENDOR_BADGE,
  VENDOR_ACTION_COMMAND_TOKENS,
  normalizeVendorAlias,
  isVendorActionCommand,
  getVendorAction,
  resolveVendorAction,
  sanitizeGuardedArgs,
  buildVendorActionMenu,
  actionChip,
  mergeProfilePatch,
  validateModelForVendor,
  // A governed codex child's session rollout is written under MUON's isolated
  // guard home, NOT `~/.codex`. Any surface that prints a `codex resume` line
  // for a human must therefore prefix that home, or the command fails in their
  // own terminal with "No saved session found". Re-exported so the TUI (which
  // depends on core, not adapters) states the SAME home the runner used —
  // spelling it out a second time is how the two would drift apart.
  codexGuardHomePath,
} from "@muon/adapters";
export type {
  VendorKey,
  ModelValidationResult,
  VendorModelPolicy,
  InvocationMode,
  ParityClass,
  GatePolicy,
  InvocationChannel,
  VendorAction,
  VendorCapabilityDescriptor,
  ResolveContext,
  ResolvedVendorAction,
  VendorActionMenuItem,
  VendorActionMenuOptions,
  VendorReadinessLike,
} from "@muon/adapters";
// P3-B: the shell-free check tokenizer lives in @muon/protocol; surfaces that
// only depend on @muon/core (e.g. the TUI) reach it through this re-export.
export {
  CheckCommandError,
  parseCheckCommand,
  resolveCheckArgv,
} from "@muon/protocol";
// ADR-0030: the one home for native take-over argv (TUI + CLI render from it).
export { takeOverArgv } from "./take-over.js";
