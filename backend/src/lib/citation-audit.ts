import { prisma } from "./db.js";
import { citedNoteIdsOf } from "./cited-findings.js";

/**
 * ADR-0065 — citation verification against the offer ledger (ADR-0060).
 *
 * A citation (`refs.noteIds` on a peer message / published finding) is
 * checked against what MUON actually put in front of the CITING job before
 * the citation was made: `offered: true` means an offer row for that note
 * exists under the citer's (job, partition) no later than the citation
 * instant.
 *
 * Three properties, inherited from the fence family:
 *  • DERIVED, never stored — like `derived_from`, the verdict is a join over
 *    the append-only ledger, so it cannot be asserted, staled, or truncated
 *    by a cap on a stored list.
 *  • FLAGGED, never dropped — a D13 relay (a peer handing a fresh note id to
 *    a sibling that has not read it yet) is legitimate; `offered: false` is
 *    information on the artifact, not a refusal. A guessed id buys nothing
 *    either way: no surface resolves a cited id on trust (ADR-0035).
 *  • FAIL-QUIET — an unreadable ledger yields NO verdicts (the field is
 *    absent), never `offered: false` for every id: an unreadable observation
 *    must not accuse (the ADR-0062 A3 rule, same family).
 *
 * ONE CORE (review finding: a single-message helper and a page helper each
 * carried the dedup/fence/fail-quiet rules, which is how inbox and
 * transcript provenance would drift): every audit below flows through
 * `auditCitationPage`, and the two exports are shapes over it.
 */
export type CitationAuditEntry = { noteId: string; offered: boolean };

type CitationQuery = {
  /** Per-JOB on purpose (review finding): the offer set is per-job, and a
   *  chat-wide check would mark a note "offered" — and reinforce it as
   *  used — when only a SIBLING had ever been shown it. A relay of a
   *  sibling's note reads `offered: false`, which is its honest label. */
  jobId: string;
  /** The citer's memory partition — belt-and-braces beside the job key. */
  partition: string;
  noteIds: readonly string[];
  /** The citation instant; offers after it do not count. */
  at: Date;
};

/**
 * The ONE audit: dedup each query's ids, read the ledger ONCE for the whole
 * page (a per-row read fanned a fully-citing 50-message transcript into 50
 * concurrent queries), and answer each query against its OWN (job,
 * partition, instant). `undefined` = the ledger was unreadable — no verdict
 * for anyone, never an accusation.
 */
async function auditCitationPage(
  queries: ReadonlyArray<CitationQuery>
): Promise<CitationAuditEntry[][] | undefined> {
  const deduped = queries.map((query) => [
    ...new Set(query.noteIds.filter((id) => id.trim() !== "")),
  ]);
  const allIds = [...new Set(deduped.flat())];
  if (allIds.length === 0) {
    return queries.map(() => []);
  }
  // The tuple fence stays IN the query (review finding: independent
  // jobId/noteId sets over-fetch the cross-product): one OR term per
  // query keeps each sender fenced to its own (job, partition, ids). The
  // ledger holds AT MOST ONE row per (job, note) — offers upsert with set
  // semantics — so the result is bounded by the page's own citations,
  // never by accumulated history.
  let offers;
  try {
    offers = await prisma.memoryOffer.findMany({
      where: {
        OR: queries.map((query, index) => ({
          jobId: query.jobId,
          partition: query.partition,
          noteId: { in: deduped[index]! },
        })),
      },
      select: { jobId: true, partition: true, noteId: true, firstAt: true },
    });
  } catch {
    return undefined;
  }
  const firstAtByTuple = new Map<string, Date>();
  for (const offer of offers) {
    firstAtByTuple.set(
      `${offer.jobId}\u0000${offer.partition}\u0000${offer.noteId}`,
      offer.firstAt
    );
  }
  return queries.map((query, index) =>
    deduped[index]!.map((noteId) => {
      const firstAt = firstAtByTuple.get(
        `${query.jobId}\u0000${query.partition}\u0000${noteId}`
      );
      return { noteId, offered: firstAt !== undefined && firstAt <= query.at };
    })
  );
}

/** One citing artifact's verdicts (send feedback, publish feedback). */
export async function auditCitationOffers(
  args: CitationQuery
): Promise<CitationAuditEntry[] | undefined> {
  const page = await auditCitationPage([args]);
  return page?.[0];
}

/**
 * ADR-0086 D4 — per-message citation audits for a page of peer-message
 * rows. The agent inbox and the operator transcript both serve this
 * sibling field, and each row is audited identically: against the SENDER's
 * job and partition at the message's own instant — the audit testifies
 * about the citer, whoever is reading. Rows without citations produce no
 * entry; an unreadable ledger produces no entries (the sibling is simply
 * absent).
 */
export async function auditPeerMessageRows(
  rows: ReadonlyArray<{
    id: string;
    fromJobId: string;
    chatId: string;
    refs: unknown;
    createdAt: Date;
  }>
): Promise<
  Array<{ messageId: string; citations: CitationAuditEntry[] }>
> {
  const citing = rows
    .map((row) => ({ row, noteIds: citedNoteIdsOf(row.refs) }))
    .filter((entry) => entry.noteIds.length > 0);
  if (citing.length === 0) {
    return [];
  }
  const page = await auditCitationPage(
    citing.map(({ row, noteIds }) => ({
      jobId: row.fromJobId,
      partition: row.chatId,
      noteIds,
      at: row.createdAt,
    }))
  );
  if (!page) {
    return [];
  }
  return citing
    .map(({ row }, index) => ({
      messageId: row.id,
      citations: page[index]!,
    }))
    .filter((entry) => entry.citations.length > 0);
}
