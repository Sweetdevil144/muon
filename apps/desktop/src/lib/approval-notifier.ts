import type { ApprovalRequest } from "@muon/client";

/**
 * BUG 2, de-dupes the "review required" native notification.
 *
 * The approvals monitor fires `onNewApproval` once per id per instance, but it is
 * rebuilt on every brain restart / settings save (a fresh `seen` set each time),
 * so the notification layer needs its OWN durable dedup: a single approval id
 * must fire exactly one notification for the life of the app, no matter how many
 * times it is announced. Ids are forgotten once they leave the pending set, so
 * the set stays bounded and only ever holds live approvals.
 */

export type ApprovalNotifierDeps = {
  /** Show the native notification for a genuinely-new pending approval. */
  show(approval: ApprovalRequest): void;
};

export type ApprovalNotifier = {
  /** Show the notification for `approval` unless its id has already fired. */
  notify(approval: ApprovalRequest): void;
  /** Forget ids no longer pending, given the current pending set, so the dedup
   *  set stays bounded (call it each poll). */
  reconcile(pending: ApprovalRequest[]): void;
};

export function createApprovalNotifier(
  deps: ApprovalNotifierDeps
): ApprovalNotifier {
  const notified = new Set<string>();
  return {
    notify(approval) {
      if (notified.has(approval.id)) {
        return;
      }
      notified.add(approval.id);
      deps.show(approval);
    },
    reconcile(pending) {
      const live = new Set(pending.map((approval) => approval.id));
      for (const id of notified) {
        if (!live.has(id)) {
          notified.delete(id);
        }
      }
    },
  };
}
