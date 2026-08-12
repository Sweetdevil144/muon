/**
 * ROADMAP / TODO 7.13 — queue a mission message while the orchestrator turn
 * is busy. Pure helpers so chat.tsx and tests share one flush/send-now policy:
 *
 * - Enqueue while `running`: local FIFO, never auto-sent.
 * - Idle flush: take the head and deliver via normal `onSend` (a new mission
 *   message once the turn settles).
 * - "Send now": deliver via governed `steer` on the root running job — not a
 *   silent approval bypass, and not a second interrupt path.
 */

export type QueuedComposerMessage = {
  id: string;
  text: string;
  enqueuedAt: number;
};

let queueSequence = 0;

function createQueuedMessageId(now: number): string {
  queueSequence += 1;
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId ?? `q-${now}-${queueSequence}`;
}

export function enqueueComposerMessage(
  queue: readonly QueuedComposerMessage[],
  text: string,
  now: number = Date.now(),
  id: string = createQueuedMessageId(now)
): QueuedComposerMessage[] {
  const trimmed = text.trim();
  if (!trimmed) return [...queue];
  return [...queue, { id, text: trimmed, enqueuedAt: now }];
}

export function dismissQueuedMessage(
  queue: readonly QueuedComposerMessage[],
  id: string
): QueuedComposerMessage[] {
  return queue.filter((entry) => entry.id !== id);
}

/** Pop the head for idle flush via onSend. Empty → null. */
export function takeNextQueuedMessage(
  queue: readonly QueuedComposerMessage[]
): {
  next: QueuedComposerMessage | null;
  remaining: QueuedComposerMessage[];
} {
  if (queue.length === 0) {
    return { next: null, remaining: [] };
  }
  const [head, ...rest] = queue;
  return { next: head ?? null, remaining: rest };
}
