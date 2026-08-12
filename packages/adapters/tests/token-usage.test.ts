import { describe, expect, it } from "vitest";
import {
  extractClaudeTokenUsage,
  extractCodexTokenUsage,
  normalizeTokenUsage,
  usageEventMetadata,
} from "../src/token-usage.js";

describe("token usage normalization", () => {
  it("reads Claude stream-json usage fields", () => {
    expect(
      extractClaudeTokenUsage({
        type: "result",
        total_cost_usd: 0.03125,
        duration_ms: 1_240,
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_input_tokens: 50,
        },
      })
    ).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 50,
      totalTokens: 1540,
      costUsd: 0.03125,
      latencyMs: 1_240,
    });
  });

  it("sums Claude modelUsage bags", () => {
    expect(
      extractClaudeTokenUsage({
        modelUsage: {
          "claude-sonnet": { input_tokens: 100, output_tokens: 20 },
          "claude-haiku": { inputTokens: 40, outputTokens: 10 },
        },
      })
    ).toEqual({
      inputTokens: 140,
      outputTokens: 30,
      totalTokens: 170,
    });
  });

  it("reads Codex turn usage params", () => {
    expect(
      extractCodexTokenUsage({
        usage: { prompt_tokens: 80, completion_tokens: 12 },
      })
    ).toEqual({
      inputTokens: 80,
      outputTokens: 12,
      totalTokens: 92,
    });
  });

  it("reads the current Codex app-server v2 token notification without double-counting thread totals", () => {
    expect(
      extractCodexTokenUsage({
        threadId: "thread-7",
        turnId: "turn-2",
        tokenUsage: {
          total: {
            inputTokens: 1_500,
            cachedInputTokens: 800,
            outputTokens: 200,
            reasoningOutputTokens: 50,
            totalTokens: 1_700,
          },
          last: {
            inputTokens: 400,
            cachedInputTokens: 250,
            outputTokens: 60,
            reasoningOutputTokens: 10,
            totalTokens: 460,
          },
          modelContextWindow: 200_000,
        },
      })
    ).toEqual({
      inputTokens: 400,
      outputTokens: 60,
      cacheReadTokens: 250,
      totalTokens: 460,
      contextUsedTokens: 400,
      contextWindowTokens: 200_000,
    });
  });

  it("refuses non-numeric / missing usage (never invents)", () => {
    expect(normalizeTokenUsage(null)).toBeNull();
    expect(normalizeTokenUsage({ input_tokens: "many" })).toBeNull();
    expect(normalizeTokenUsage({ message: "hello" })).toBeNull();
  });

  it("builds event metadata with vendor", () => {
    expect(
      usageEventMetadata("claude-code", {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        costUsd: 0.004,
        latencyMs: 42,
        contextUsedTokens: 7,
        contextWindowTokens: 100,
      })
    ).toEqual({
      usage: {
        vendor: "claude-code",
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        costUsd: 0.004,
        latencyMs: 42,
        contextUsedTokens: 7,
        contextWindowTokens: 100,
      },
    });
  });
});
