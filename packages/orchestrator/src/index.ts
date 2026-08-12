export {
  runChatTurn,
  CHAT_LANE_KEY,
  ORCHESTRATOR_LANE_KEYS,
  buildJobTerminalEnvelope,
  jobTerminalMilestone,
} from "./chat.js";
export type {
  ChatTurnInput,
  ChatTurnResult,
  JobTerminalEvent,
  MissionRoster,
  OrchestratorLaneKey,
} from "./chat.js";
// The ONE brief-heading contract, shared by the system-prompt template and the
// dispatch-contract verifier (see brief-contract.ts for why it is one list).
export {
  CHILD_BRIEF_HEADINGS,
  CREW_TASK_HEADINGS,
  briefHeadingList,
  briefHeadingMandate,
  childBriefSkeleton,
  declaredHeadings,
  headingValue,
  missingBriefHeadings,
  missingTaskHeadings,
  taskHeadingList,
} from "./brief-contract.js";
export {
  ORCHESTRATOR_SYSTEM_PROMPT,
  ORCHESTRATOR_TURN_PREAMBLE,
} from "./system-prompt.js";
// Surface-independent S4 reconcile core, shared by the persistent runner and
// the desktop monitor (which re-exports it from a shim). Also available via the
// lightweight `@muon/orchestrator/reconcile` subpath for CJS startup paths that
// must not eagerly load the heavy index.
export {
  AUTO_CONTINUE_CAP,
  decideContinuation,
  reconcileTerminalJob,
  fileJobTerminalGate,
  isWatchedWorkerJob,
  countAutoTurnsSinceHuman,
} from "./reconcile.js";
export type {
  ContinuationDecision,
  TerminalJobEvent,
  ReconcileOutcome,
  ReconcileDeps,
  UncertainGateClient,
} from "./reconcile.js";
export {
  detectStuckPattern,
  normalizeStuckText,
  stuckStepsFromChunks,
} from "./stuck-detector.js";
export type {
  StuckHalt,
  StuckPattern,
  StuckStep,
} from "./stuck-detector.js";
