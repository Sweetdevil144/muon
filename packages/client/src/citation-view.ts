import type { CitationAuditEntry } from "@muon/protocol";

/**
 * ADR-0086 D2/D4 — the ONE statement of what a citation's offered verdict
 * MEANS on a human surface. `handoff-view`'s pattern, applied to the
 * citation family: every surface that renders a cited note id resolves its
 * provenance sentence HERE, so no desk, dock, or CLI states a rule of its
 * own about what `offered` says.
 *
 * The vocabulary is 0065's, closed:
 *  • `offered: true`  → "cited, offered to this job" — the brain put this
 *    note in front of the CITING job before the citation was made.
 *  • `offered: false` → "cited, never offered — relay" — legitimate (a D13
 *    relay hands a sibling a fresh id), labelled, NEVER dropped, and never
 *    a pass/fail color: it is provenance, not a verdict on the work.
 *  • no verdict       → `null` — the ledger was unreadable or no audit
 *    accompanied this read. An unreadable observation must not accuse
 *    (0062 A3), so the surface renders the citation with NO provenance
 *    claim rather than inventing one.
 */
export function citationProvenanceLabel(
  noteId: string,
  citations: ReadonlyArray<CitationAuditEntry> | undefined
): string | null {
  const entry = citations?.find((candidate) => candidate.noteId === noteId);
  if (!entry) return null;
  return entry.offered
    ? "cited, offered to this job"
    : "cited, never offered — relay";
}

/**
 * The line a surface prints for one cited note id: the id (as given — the
 * caller owns any sanitizing/slicing) plus the provenance sentence when a
 * verdict exists. Flagged never DROPS: every cited id yields a line.
 */
export function citationProvenanceLine(
  displayId: string,
  noteId: string,
  citations: ReadonlyArray<CitationAuditEntry> | undefined
): string {
  const label = citationProvenanceLabel(noteId, citations);
  return label ? `${displayId} — ${label}` : `${displayId} — cited`;
}
