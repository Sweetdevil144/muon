/**
 * THE brief contract, re-exported. The implementation MOVED to
 * `@muon/protocol` (`packages/protocol/src/brief-contract.ts`) — read that
 * header for the four drifts and for why the list cannot live here.
 *
 * The short version: `@muon/mcp` does not depend on `@muon/orchestrator`, so the
 * `dispatch` tool description — the one artifact an externally launched
 * coordinator reads — could not import the list and restated it in prose. It
 * then drifted to ten of twelve headings and the verifier refused the children a
 * compliant coordinator produced.
 *
 * This file stays as a re-export so `chat.ts`, `system-prompt.ts`, `index.ts`,
 * and the drift-lock test keep importing `./brief-contract.js` unchanged. There
 * is exactly one array; this is a second NAME for it, never a second copy.
 */
export {
  CHILD_BRIEF_HEADINGS,
  CREW_TASK_HEADINGS,
  HEADING_ALIASES,
  briefHeadingList,
  briefHeadingMandate,
  childBriefSkeleton,
  declaredHeadings,
  headingValue,
  headingValues,
  missingBriefHeadings,
  missingTaskHeadings,
  taskHeadingList,
} from "@muon/protocol";
export type { ChildBriefHeading } from "@muon/protocol";
