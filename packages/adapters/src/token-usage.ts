/**
 * Vendor token-usage normalization.
 *
 * Claude stream-json `result` messages and Codex turn payloads expose usage
 * under several shapes. We only accept explicit numeric fields — never guess
 * from string lengths or exit codes. Cursor has no managed usage signal yet.
 */

export type VendorTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  /** Vendor-reported dollars for this response/session result. Never inferred. */
  costUsd?: number;
  /** Vendor-reported end-to-end response duration. Never wall-clock reconstructed. */
  latencyMs?: number;
  /** Explicit input-context use paired with an explicit model window. */
  contextUsedTokens?: number;
  contextWindowTokens?: number;
};

function asNonNegInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  }
  return undefined;
}

function asNonNegNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

function pickUsageRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/**
 * Extract usage from a Claude Agent SDK / CLI stream-json message (typically
 * `type: "result"`), or any nested `usage` / `modelUsage` bag.
 */
export function extractClaudeTokenUsage(
  message: Record<string, unknown> | null | undefined
): VendorTokenUsage | null {
  if (!message) return null;
  const measurements = {
    ...(asNonNegNumber(message.total_cost_usd) !== undefined
      ? { costUsd: asNonNegNumber(message.total_cost_usd) }
      : {}),
    ...(asNonNegInt(message.duration_ms) !== undefined
      ? { latencyMs: asNonNegInt(message.duration_ms) }
      : {}),
  };
  const direct = normalizeTokenUsage(message.usage);
  if (direct) return { ...direct, ...measurements };

  const modelUsage = pickUsageRecord(message.modelUsage);
  if (modelUsage) {
    // modelUsage is often keyed by model id; sum honest numeric fields.
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let saw = false;
    for (const value of Object.values(modelUsage)) {
      const part = normalizeTokenUsage(value);
      if (!part) continue;
      saw = true;
      input += part.inputTokens;
      output += part.outputTokens;
      cacheRead += part.cacheReadTokens ?? 0;
      cacheWrite += part.cacheWriteTokens ?? 0;
    }
    if (saw) {
      return {
        inputTokens: input,
        outputTokens: output,
        ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
        totalTokens: input + output,
        ...measurements,
      };
    }
  }
  return null;
}

/** Extract usage from a Codex app-server notification/result params bag. */
export function extractCodexTokenUsage(
  params: Record<string, unknown> | null | undefined
): VendorTokenUsage | null {
  if (!params) return null;
  const threadUsage = pickUsageRecord(params.tokenUsage);
  if (threadUsage) {
    // `total` is cumulative for the thread. Persisting it on every completed
    // turn would double-count; `last` is the response-local v2 breakdown.
    const last = normalizeTokenUsage(threadUsage.last);
    if (last) {
      const contextWindowTokens = asNonNegInt(
        threadUsage.modelContextWindow
      );
      return {
        ...last,
        ...(contextWindowTokens !== undefined && contextWindowTokens > 0
          ? {
              contextUsedTokens: last.inputTokens,
              contextWindowTokens,
            }
          : {}),
      };
    }
  }
  return (
    normalizeTokenUsage(params.usage) ??
    normalizeTokenUsage(params.token_usage) ??
    normalizeTokenUsage(params.tokenUsage) ??
    normalizeTokenUsage(params)
  );
}

export function normalizeTokenUsage(raw: unknown): VendorTokenUsage | null {
  const record = pickUsageRecord(raw);
  if (!record) return null;

  const inputTokens =
    asNonNegInt(record.input_tokens) ??
    asNonNegInt(record.inputTokens) ??
    asNonNegInt(record.prompt_tokens) ??
    asNonNegInt(record.promptTokens);
  const outputTokens =
    asNonNegInt(record.output_tokens) ??
    asNonNegInt(record.outputTokens) ??
    asNonNegInt(record.completion_tokens) ??
    asNonNegInt(record.completionTokens);

  if (inputTokens === undefined && outputTokens === undefined) {
    return null;
  }

  const cacheReadTokens =
    asNonNegInt(record.cached_input_tokens) ??
    asNonNegInt(record.cachedInputTokens) ??
    asNonNegInt(record.cache_read_input_tokens) ??
    asNonNegInt(record.cacheReadInputTokens) ??
    asNonNegInt(record.cache_read_tokens) ??
    asNonNegInt(record.cacheReadTokens);
  const cacheWriteTokens =
    asNonNegInt(record.cache_creation_input_tokens) ??
    asNonNegInt(record.cacheCreationInputTokens) ??
    asNonNegInt(record.cache_write_tokens) ??
    asNonNegInt(record.cacheWriteTokens);
  const totalTokens =
    asNonNegInt(record.total_tokens) ??
    asNonNegInt(record.totalTokens) ??
    (inputTokens ?? 0) + (outputTokens ?? 0);

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    totalTokens,
  };
}

/** Metadata shape attached to lane events when usage is known. */
export function usageEventMetadata(
  vendor: string,
  usage: VendorTokenUsage
): Record<string, unknown> {
  return {
    usage: {
      vendor,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheReadTokens !== undefined
        ? { cacheReadTokens: usage.cacheReadTokens }
        : {}),
      ...(usage.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: usage.cacheWriteTokens }
        : {}),
      ...(usage.totalTokens !== undefined
        ? { totalTokens: usage.totalTokens }
        : {}),
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
      ...(usage.latencyMs !== undefined
        ? { latencyMs: usage.latencyMs }
        : {}),
      ...(usage.contextUsedTokens !== undefined
        ? { contextUsedTokens: usage.contextUsedTokens }
        : {}),
      ...(usage.contextWindowTokens !== undefined
        ? { contextWindowTokens: usage.contextWindowTokens }
        : {}),
    },
  };
}
