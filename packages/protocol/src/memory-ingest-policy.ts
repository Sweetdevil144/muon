import { z } from "zod";

/** TODO 4.7 — bounded operator-authored ingest deny/allow lists (deterministic). */
export const MEMORY_INGEST_POLICY_MAX_PATTERNS = 32;
export const MEMORY_INGEST_POLICY_MAX_PATTERN_LENGTH = 128;

const patternSchema = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_INGEST_POLICY_MAX_PATTERN_LENGTH);

export const memoryIngestPolicySchema = z.object({
  deny: z.array(patternSchema).max(MEMORY_INGEST_POLICY_MAX_PATTERNS).default([]),
  allow: z.array(patternSchema).max(MEMORY_INGEST_POLICY_MAX_PATTERNS).default([]),
});

export type MemoryIngestPolicy = z.infer<typeof memoryIngestPolicySchema>;

export const EMPTY_MEMORY_INGEST_POLICY: MemoryIngestPolicy = {
  deny: [],
  allow: [],
};

export type MemoryIngestPolicyParse =
  | { ok: true; policy: MemoryIngestPolicy }
  | { ok: false; reason: string };

/** Parse operator settings JSON (or a plain object body). */
export function parseMemoryIngestPolicy(value: unknown): MemoryIngestPolicyParse {
  const parsed = memoryIngestPolicySchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues[0]?.message ?? "invalid ingest policy",
    };
  }
  return { ok: true, policy: parsed.data };
}

function normalizePatterns(patterns: readonly string[]): string[] {
  return patterns.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function matchesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

export type MemoryIngestPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Deterministic substring policy — no regex, no model. Deny wins first; a
 * non-empty allow list then requires at least one allow hit.
 */
export function evaluateMemoryIngestPolicy(
  text: string,
  policy: MemoryIngestPolicy
): MemoryIngestPolicyDecision {
  const normalized = text.toLowerCase();
  const deny = normalizePatterns(policy.deny);
  const allow = normalizePatterns(policy.allow);

  if (deny.length > 0 && matchesAny(normalized, deny)) {
    return { allowed: false, reason: "note text matched an ingest deny pattern" };
  }
  if (allow.length > 0 && !matchesAny(normalized, allow)) {
    return {
      allowed: false,
      reason: "note text did not match any ingest allow pattern",
    };
  }
  return { allowed: true };
}
