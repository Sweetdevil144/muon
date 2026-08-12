/**
 * TODO 5.4 — Stuck detector as a *reason*, not a count.
 *
 * Five named patterns with thresholds. Semantic comparison ignores ids and
 * timestamps so "same Edit on file X with a new cuid" still counts as identical.
 * Pure: no I/O. Surfaces call {@link detectStuckPattern} over recent activity
 * steps and feed the result into {@link decideContinuation}.
 */

export type StuckPattern =
  | "identical_action_observation"
  | "action_error"
  | "monologue"
  | "ping_pong_alternation"
  | "context_window_error";

export type StuckHalt = {
  pattern: StuckPattern;
  count: number;
  /** Operator-facing line, e.g. "Halted: alternating pattern ×6". */
  message: string;
};

export type StuckStep = {
  /** Normalized fingerprint for equality / alternation. */
  key: string;
  /** True when this step looks like a tool action (vs assistant monologue). */
  isAction: boolean;
  /** True when the observation/result looks like an error. */
  isError: boolean;
  /** True when the text names a context-window / token-limit failure. */
  isContextWindowError: boolean;
  /**
   * Trusted control-plane progress boundary. It carries no agent text and is
   * never itself classified; detectors inspect only the steps after the latest
   * boundary. A terminal-child milestone means the crew made external progress,
   * so identical summaries on either side are not one stuck monologue.
   */
  boundary?: boolean;
};

const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const CUID = /\b(?:c[a-z0-9]{20,}|[a-z]+_[a-z0-9]{8,})\b/gi;
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g;
const EPOCH_MS = /\b1[5-9]\d{11}\b/g;
const HEX_LONG = /\b[0-9a-f]{16,}\b/gi;

const CONTEXT_WINDOW_RE =
  /context\s*(?:window|length)|(?:maximum|max)\s*context|token\s*limit|context_length_exceeded|prompt\s*is\s*too\s*long|too\s*many\s*tokens/i;

const ERROR_RE =
  /\b(?:error|failed|failure|denied|refused|exception|traceback|ENOENT|EACCES|EPERM)\b/i;

const THRESHOLDS: Record<StuckPattern, number> = {
  identical_action_observation: 4,
  action_error: 3,
  monologue: 3,
  ping_pong_alternation: 6,
  context_window_error: 2,
};

const PATTERN_LABEL: Record<StuckPattern, string> = {
  identical_action_observation: "identical action/observation",
  action_error: "action/error",
  monologue: "monologue",
  ping_pong_alternation: "alternating pattern",
  context_window_error: "repeated context-window errors",
};

/** Strip volatile tokens so semantic duplicates compare equal. */
export function normalizeStuckText(text: string): string {
  return text
    .replace(UUID, "<id>")
    .replace(CUID, "<id>")
    .replace(ISO_TIME, "<time>")
    .replace(EPOCH_MS, "<time>")
    .replace(HEX_LONG, "<hex>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Project stream chunks since the last human message into stuck steps.
 * Kind-gated: only `activity` and `output` contribute classifier payload.
 * Trusted `milestone` chunks contribute a payload-free progress boundary.
 */
export function stuckStepsFromChunks(
  chunks: readonly {
    content: string;
    kind: string;
    detail?: { args?: string; result?: string } | null;
  }[]
): StuckStep[] {
  let lastHuman = -1;
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const chunk = chunks[i]!;
    if (
      chunk.kind === "user.message" &&
      chunk.content.startsWith("[you] ")
    ) {
      lastHuman = i;
      break;
    }
  }
  const steps: StuckStep[] = [];
  for (let i = lastHuman + 1; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    if (chunk.kind === "milestone") {
      steps.push({
        key: "control-progress-boundary",
        isAction: false,
        isError: false,
        isContextWindowError: false,
        boundary: true,
      });
      continue;
    }
    if (chunk.kind === "activity") {
      const args = chunk.detail?.args ?? "";
      const result = chunk.detail?.result ?? "";
      const blob = `${chunk.content}\n${args}\n${result}`;
      const key = normalizeStuckText(
        `${chunk.content}|${args}|${result.slice(-240)}`
      );
      if (!key) continue;
      steps.push({
        key,
        isAction: true,
        isError: ERROR_RE.test(result) || ERROR_RE.test(chunk.content),
        isContextWindowError: CONTEXT_WINDOW_RE.test(blob),
      });
      continue;
    }
    if (chunk.kind === "output" || chunk.kind === "output.message") {
      const key = normalizeStuckText(chunk.content.slice(0, 400));
      if (!key || key.length < 12) continue;
      steps.push({
        key,
        isAction: false,
        isError: ERROR_RE.test(chunk.content),
        isContextWindowError: CONTEXT_WINDOW_RE.test(chunk.content),
      });
    }
  }
  return steps;
}

function halt(pattern: StuckPattern, count: number): StuckHalt {
  return {
    pattern,
    count,
    message: `Halted: ${PATTERN_LABEL[pattern]} ×${count}`,
  };
}

/**
 * Detect the strongest stuck pattern in `steps` (most recent evidence wins when
 * multiple thresholds are met). Returns null when nothing has crossed a bar.
 */
export function detectStuckPattern(
  steps: readonly StuckStep[]
): StuckHalt | null {
  let boundary = -1;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i]!.boundary) {
      boundary = i;
      break;
    }
  }
  const active = steps.slice(boundary + 1);
  if (active.length === 0) return null;

  // Prefer the most recent window so a recovered streak does not fire.
  const contextHits = trailingCount(active, (s) => s.isContextWindowError);
  if (contextHits >= THRESHOLDS.context_window_error) {
    return halt("context_window_error", contextHits);
  }

  const identical = trailingIdenticalActions(active);
  if (identical >= THRESHOLDS.identical_action_observation) {
    return halt("identical_action_observation", identical);
  }

  const actionError = trailingActionError(active);
  if (actionError >= THRESHOLDS.action_error) {
    return halt("action_error", actionError);
  }

  const mono = trailingMonologue(active);
  if (mono >= THRESHOLDS.monologue) {
    return halt("monologue", mono);
  }

  const ping = trailingPingPong(active);
  if (ping >= THRESHOLDS.ping_pong_alternation) {
    return halt("ping_pong_alternation", ping);
  }

  return null;
}

function trailingCount(
  steps: readonly StuckStep[],
  pred: (s: StuckStep) => boolean
): number {
  let n = 0;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (!pred(steps[i]!)) break;
    n += 1;
  }
  return n;
}

function trailingIdenticalActions(steps: readonly StuckStep[]): number {
  const last = steps[steps.length - 1];
  if (!last?.isAction) return 0;
  let n = 0;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    if (!step.isAction || step.key !== last.key) break;
    n += 1;
  }
  return n;
}

function trailingActionError(steps: readonly StuckStep[]): number {
  // Count consecutive action steps that errored (same or different tools).
  let n = 0;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    if (!step.isAction || !step.isError) break;
    n += 1;
  }
  return n;
}

function trailingMonologue(steps: readonly StuckStep[]): number {
  let n = 0;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    if (step.isAction) break;
    n += 1;
  }
  // Require near-duplicate monologue text, not three unrelated essays.
  if (n < THRESHOLDS.monologue) return n;
  const window = steps.slice(-n);
  const first = window[0]!.key;
  const similar = window.every(
    (s) => s.key === first || jaccardBigrams(s.key, first) >= 0.7
  );
  return similar ? n : 0;
}

function trailingPingPong(steps: readonly StuckStep[]): number {
  if (steps.length < THRESHOLDS.ping_pong_alternation) return 0;
  const window = steps.slice(-THRESHOLDS.ping_pong_alternation);
  const a = window[0]!.key;
  const b = window[1]!.key;
  if (!a || !b || a === b) return 0;
  for (let i = 0; i < window.length; i += 1) {
    const expected = i % 2 === 0 ? a : b;
    if (window[i]!.key !== expected) return 0;
  }
  return window.length;
}

/** Cheap similarity for monologue near-duplicates. */
function jaccardBigrams(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < text.length - 1; i += 1) {
    out.add(text.slice(i, i + 2));
  }
  return out;
}
