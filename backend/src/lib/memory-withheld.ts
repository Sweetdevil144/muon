import {
  matchesMemoryFilter,
  type MemoryFilter,
  type MemoryFilterRecord,
} from "@muon/protocol";
import { prisma } from "./db.js";
import { applyMemoryExpiry } from "./memory-ledger.js";

/**
 * The agent-tier crew-read predicate — ONE spelling, shared by the serve
 * path (`crewReadableMemoryView`, routes/memory.ts) and the disclosure
 * classifier below, so serving eligibility and disclosure eligibility can
 * never drift (review finding).
 */
export function crewReadable(
  note: { confirmedBy: "human" | "orchestrator" | null; chatId?: string | null },
  options: { tier: "operator" | "agent"; chatId?: string; crewVisible: boolean }
): boolean {
  if (options.tier === "operator") return true;
  return (
    note.confirmedBy === "human" ||
    (options.crewVisible &&
      Boolean(options.chatId) &&
      note.chatId === options.chatId)
  );
}

// ── ADR-0061 — recall says what it withheld ─────────────────────────────────
//
// The ROUTE half: the graph hands back bounded withheld CANDIDATES (full
// records) beside its notes, and this classifier re-fences them against the
// ledger before anything reaches a caller. The taxonomy is D1's:
//  • FENCE class (crew/trust tier, foreign partition) — SILENT. A stub here
//    is the existence oracle the wall exists to refuse.
//  • Lifecycle (rejected/superseded — not live) and caller-requested
//    narrowing (the R5 filter) — SILENT: neither is "withheld", one is dead
//    and the other was never asked for.
//  • POLICY class — identifier-only stubs: {id, kind, reason} with reason
//    expired | paused | stale. Ledger truth wins over the graph's mirror
//    (an expired-by-ledger candidate stubs as expired whatever the graph
//    thought it was).
//  • CAP class — a count: "N more matched, ranked below the cap."
// Bounded and deterministic; absent fields mean nothing suppressed (D2).
export const WITHHELD_RESPONSE_STUB_BOUND = 30;

export type WithheldStub = {
  id: string;
  kind: string;
  reason: "expired" | "paused" | "stale";
};

export async function classifyWithheldDisclosure(input: {
  candidates: ReadonlyArray<{
    note: {
      id: string;
      kind: string;
      status?: string;
      confirmed?: boolean;
      chatId?: string | null;
      scope?: string | null;
    };
    reason: "cap" | "stale" | "expired" | "paused";
  }>;
  tier: "operator" | "agent";
  chatId?: string;
  crewVisible: boolean;
  memoryFilter?: MemoryFilter;
  asOf?: string;
  /** Operator view that already SHOWS expired notes: an expired candidate is
   *  then ordinary cap/stale suppression, never an "expired" stub. */
  showExpiredView: boolean;
}): Promise<{ suppressedCount: number; withheld: WithheldStub[] }> {
  if (input.candidates.length === 0) {
    return { suppressedCount: 0, withheld: [] };
  }
  // Dedupe by id, first reason wins (graph candidates precede main-set drops).
  const seen = new Set<string>();
  const pool = input.candidates.filter(({ note }) => {
    if (seen.has(note.id)) return false;
    seen.add(note.id);
    return true;
  });
  // THE LEDGER CANARY (review finding): a stub is an accusation-shaped
  // claim about a note's policy state, so it requires a REAL ledger row.
  // `applyMemoryExpiry` degrades to NEUTRAL annotations when its lookup
  // fails — indistinguishable from a live unconfirmed row — so the rows
  // are read here first, fail-quiet: an unreadable ledger discloses
  // NOTHING rather than classifying from the graph's mirror.
  let ledgerRows: { id: string; status: string }[];
  try {
    ledgerRows = await prisma.memoryNote.findMany({
      where: { id: { in: pool.map(({ note }) => note.id) } },
      select: { id: true, status: true },
    });
  } catch {
    return { suppressedCount: 0, withheld: [] };
  }
  const ledgerById = new Map(ledgerRows.map((row) => [row.id, row]));
  // Ledger truth for the WHOLE pool, nothing dropped yet: showRetired keeps
  // lifecycle rows visible so they can be classified (silent), and
  // showExpired keeps expired rows so they can stub.
  const annotated = await applyMemoryExpiry(
    pool.map(({ note }) => note),
    { showRetired: true, showExpired: true, asOf: input.asOf }
  );
  const byId = new Map(annotated.map((note) => [note.id, note]));
  let suppressedCount = 0;
  const withheld: WithheldStub[] = [];
  for (const { note, reason } of pool) {
    const truth = byId.get(note.id);
    if (!truth) continue;
    // No ledger row = a mirror-only candidate. It cannot stub (nothing
    // authoritative to disclose) and does not count.
    const ledger = ledgerById.get(note.id);
    if (!ledger) continue;
    // Lifecycle: not live = dead, not withheld.
    if (!truth.live) continue;
    // FENCE (agent tier): the ONE crew-read predicate the serve path uses —
    // a candidate the caller could never have been served must not stub.
    if (
      !crewReadable(
        { confirmedBy: truth.confirmedBy, chatId: note.chatId },
        {
          tier: input.tier,
          ...(input.chatId ? { chatId: input.chatId } : {}),
          crewVisible: input.crewVisible,
        }
      )
    ) {
      continue;
    }
    // Caller-requested narrowing: a filtered-out note was never asked for.
    if (
      input.memoryFilter &&
      !matchesMemoryFilter(
        truth as unknown as MemoryFilterRecord,
        input.memoryFilter
      )
    ) {
      continue;
    }
    if (truth.expired && !input.showExpiredView) {
      if (withheld.length < WITHHELD_RESPONSE_STUB_BOUND) {
        withheld.push({ id: note.id, kind: note.kind, reason: "expired" });
      }
      continue;
    }
    // Ledger truth wins (review finding): a lagging graph projection must
    // neither stub an active note as paused nor count a ledger-paused note
    // as mere cap overflow. The row read above is the authority.
    if (ledger.status === "paused") {
      if (withheld.length < WITHHELD_RESPONSE_STUB_BOUND) {
        withheld.push({ id: note.id, kind: note.kind, reason: "paused" });
      }
      continue;
    }
    if (reason === "stale") {
      if (withheld.length < WITHHELD_RESPONSE_STUB_BOUND) {
        withheld.push({ id: note.id, kind: note.kind, reason: "stale" });
      }
      continue;
    }
    suppressedCount += 1;
  }
  return { suppressedCount, withheld };
}

/** D2: the two additive response fields, absent when nothing suppressed. */
export function withheldResponseFields(disclosure: {
  suppressedCount: number;
  withheld: WithheldStub[];
}): {
  suppressed_count?: number;
  withheld?: WithheldStub[];
} {
  return {
    ...(disclosure.suppressedCount > 0
      ? { suppressed_count: disclosure.suppressedCount }
      : {}),
    ...(disclosure.withheld.length > 0
      ? { withheld: disclosure.withheld }
      : {}),
  };
}

