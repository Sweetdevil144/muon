import type { ReviewThreadTarget } from "../shared/ipc.js";
import { requireRendererRecordId } from "./renderer-chat-scope.js";

/**
 * H1 — the IPC-boundary fence for the bound review thread's two verbs.
 *
 * Extracted from `muon:reviewThread` / `muon:advanceReviewLook` because the
 * handlers claimed in a comment to be "fenced exactly like `muon:taskHandoffs`"
 * and were not (adversarial review, 2026-08-17). Two holes, both closed here
 * and both now testable without Electron:
 *
 *  1. `targetKind` arrived from the renderer UNVALIDATED and was interpolated
 *     into the client's request path (`/api/review-thread/${targetKind}/…`),
 *     which `encodeURIComponent` on the id alone does not cover. A kind of
 *     `"../../api/chats"` resolves to a different operator-tier route, sent
 *     with the operator token. Narrow reach — everything but `"task"` still has
 *     to equal the bound chat id — but `requireRendererRecordId` exists
 *     precisely so a renderer-supplied path segment is bounded BEFORE it is
 *     asked about, and this is now the only way to build one of these targets.
 *
 *  2. The renderer may only ask about its OWN mission. A `"chat"` target must
 *     BE the bound chat; a `"task"` target is authorized by the caller with the
 *     same `requireRendererTask` every neighbouring handler uses (that read
 *     needs the client, so it stays at the call site — this function returns
 *     the shape that still has to be authorized).
 *
 * The cursor is display state and grants nothing, so a refusal here costs an
 * operator a strip and never a decision.
 */

const TARGET_KINDS = ["task", "chat"] as const;

export type ReviewThreadScope =
  | { kind: "task"; target: ReviewThreadTarget; taskId: string }
  | { kind: "chat"; target: ReviewThreadTarget };

export function resolveReviewThreadTarget(
  input: { targetKind?: unknown; targetId?: unknown },
  boundChatId: string | null
): ReviewThreadScope {
  const targetKind = input?.targetKind;
  // ENUMERATED, not merely "a string": a kind MUON does not name by hand is
  // refused rather than forwarded into a URL path segment.
  if (
    typeof targetKind !== "string" ||
    !(TARGET_KINDS as readonly string[]).includes(targetKind)
  ) {
    throw new Error("A review thread is about a task or a chat, nothing else.");
  }
  const targetId = requireRendererRecordId(input?.targetId, "review thread");
  if (targetKind === "chat") {
    if (!boundChatId || targetId !== boundChatId) {
      throw new Error("That review thread is not the selected mission's.");
    }
    return { kind: "chat", target: { targetKind: "chat", targetId } };
  }
  if (!boundChatId) {
    throw new Error("Select a mission before reading its review thread.");
  }
  return {
    kind: "task",
    target: { targetKind: "task", targetId },
    taskId: targetId,
  };
}
