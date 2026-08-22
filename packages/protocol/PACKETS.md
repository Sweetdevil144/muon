# The exchange contracts changelog (ADR-0070)

> The changelog IS part of the schema: a version bump lands with its entry
> here in the same commit. Two contracts, two lifecycles — see
> `src/exchange-contracts.ts` for why they are deliberately not one.

## Version rules

- **Within a major**: additive OPTIONAL fields only; consumers ignore what
  they do not know.
- **Unknown major**: refused WHOLE, with the version named in the refusal
  (never best-effort parsed — zod strips fields it does not know, which is
  exactly how a future packet's provenance would quietly fall off). The
  enforcement point is the boundary where another producer's artifact
  enters the brain: the terminal dispatch transition for packets, the
  import route for memory packs.
- **Discovery**: `whoami` reports the live server's spoken contracts;
  `muon mcp probe` reports the installed pair's. A consumer negotiates by
  reading, not by trying.

## Packet family (dispatch pack · wrap/handoff packet · continuation)

The family versions TOGETHER because the packets travel together: a
continuation reads a wrap that quotes a dispatch pack. The family major
tracks `HANDOFF_PACKET_VERSION` (`src/handoff.ts`).

| Family | Wire anchor | Landed | What changed |
|---|---|---|---|
| 2.0.0 | `schemaVersion: 2` | 2026-08 (P0.3) | The typed terminal contract: `changedFiles`, `diffHash`/`diffVerified`, typed `checks`, `artifacts`, `uncertainties`, `unresolvedDecisions`, `memoryProposals`, `finalMessage` (the durable second copy), the named-degradation channel (`degraded.reasons`), and — 2026-08-21, additive within the major — `brainReceipt` (ADR-0062) with its two server-stamped degradation codes. |
| 1 | `schemaVersion: 1` (defaulted) | pre-P0.3 | The prose-era packet: goal/changed/failed/next + commands/checks/questions and lane provenance. Still parses — every v2 field is defaulted/optional. |

## Memory pack (the at-rest machine boundary — ADR-0064)

| Version | Landed | What it is |
|---|---|---|
| 1 | 2026-08 (P1.4 Slice 1) | Human-confirmed, workspace-fenced records; redact-before-serialize; per-record content hashes bound to the confirmation; origin fingerprint; deterministic serialization (re-export of unchanged content is byte-identical); tombstones. Import (ADR-0038) refuses any other version at BOTH the manifest and the record level, and every accepted record lands as an unconfirmed proposal. |
| 1 (additive, 2026-08-22) | ADR-0064 A1 residual | Optional `provenance` block on records: the ADR-0058 LATEST grounding stamp (verdict, at, check KINDS — details stay home, they may carry machine-local paths) and the ADR-0060 offer-derived lineage summary (distinct chat/job COUNTS + time bounds — ids never leave). Data, never authority: the importer parses it (the content address covers it) and materialises nothing — grounding is re-run against the receiving repo. Absent on notes with neither, so pre-enrichment record hashes are unchanged. |
