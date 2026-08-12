import { Prisma } from "@prisma/client";
import { z } from "zod";
import { redactForPack } from "@muon/client";
import type { MemoryNoteInput } from "@muon/graph";
import { isHumanPrincipal } from "./auth.js";
import { prisma } from "./db.js";
import { mirrorToGraph } from "./graph.js";
import {
  computeMemoryTextHash,
  getMemoryNote,
  ingestMemoryNote,
} from "./memory-ledger.js";
import {
  MEMORY_PACK_MAX_RECORDS,
  MEMORY_PACK_MAX_REDACTION_CHARS,
  MEMORY_PACK_MAX_TEXT_CHARS,
  MEMORY_PACK_MAX_TOMBSTONES,
  MEMORY_PACK_VERSION,
  packDigestOf,
  recordHashOf,
  workspaceFingerprint,
  type MemoryPackRecord,
} from "./memory-pack.js";

// ── P1.4 Slice 2: workspace memory PACKS (import side) ───────────────────────
//
// The import surface assumes a HOSTILE pack. The server re-verifies EVERYTHING
// (it never trusts the CLI): pack digest, per-record content address, the
// confirmation⇔content hash binding, human-principal origin confirmation, size
// caps, and a defense-in-depth redaction re-run. Verdicts are degrade-safe:
//   • a PACK-level defect (version / digest / manifest shape / record cap /
//     self-pack) refuses the WHOLE pack with a stated reason;
//   • a RECORD-level defect refuses THAT record with a stated reason and
//     continues with its honest siblings;
// both are reported honestly in the deterministic import report.
//
// The confirmed-only moat is enforced STRUCTURALLY, not by flag:
//   • an accepted record goes through `ingestMemoryNote` with
//     `proposalOnly: true`, `trust: "low"`, `createdBy: "pack:<fingerprint>"` —
//     the full dedup/conflict machinery runs, but every destructive verdict
//     degrades to a non-destructive branch (an import can retire NOTHING);
//   • NO Confirmation row is ever written here. The origin confirmation lands
//     only in the `MemoryImport` provenance table (data, never authority), so
//     the note is invisible to `recallForGate`/agent slices until a human in
//     the RECEIVING workspace confirms it through the EXISTING PATCH flow;
//
// ADR-0026 §7 (step 5) adds the PARTITION, and it is two columns because there are
// two questions:
//   • `MemoryNote.workspacePath` — the LOCAL partition, stamped with the RECEIVING
//     workspace (validated + `repoRootOf`-reduced at the route). It is authority:
//     it decides which repo's agents may read the proposal and which pack it may
//     ever leave in. It is therefore NEVER read out of the pack — a record's
//     contents cannot name it, and an absent receiving workspace lands NULL (§8's
//     residue: operator-visible, agent-invisible, non-exportable) rather than a
//     guessed `process.cwd()`. Guessing an authority-bearing value is worse than
//     admitting we have none.
//   • `MemoryImport.originWorkspace` — the salted opaque `ws-<16 hex>` fingerprint
//     of the SENDER, which is provenance DATA.
//
//     PROSE is redacted by `redactForPack` on BOTH sides: credential shapes, then
//     absolute filesystem paths and machine-local hostnames. That claim used to
//     read "no absolute path, hostname or username may ever ride a pack" and was
//     FALSE — the only filter was the secret-shape redactor, and a security review
//     exported a note carrying an absolute client path and a `.local` hostname
//     verbatim. What is guaranteed now is what the redactor's stated pattern set
//     covers, which is a pattern claim rather than a proof: a path written in an
//     unusual shape can still slip through, and the honest posture is that a pack
//     is REVIEWED by a human before it is shared, not that it is sanitised.
// The idempotence key is `(originWorkspace, receivingWorkspace, recordHash)`, so
// one pack imported into two local workspaces produces two independent sets of
// proposals instead of the second being swallowed as `alreadyImported`.
//   • tombstones propagate revocation/supersession as a SET-ONCE `staleSince`
//     review flag + a system "reconcile" marker — never an auto-retire. A local
//     human confirm clears the flag; a reject retires the note.

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const fingerprintSchema = z.string().regex(/^ws-[0-9a-f]{16}$/);
const isoDateSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "must be a parseable ISO-8601 date-time",
  });

const tombstoneSchema = z.object({
  originNoteId: z.string().min(1),
  textHash: sha256HexSchema,
  reason: z.enum(["superseded", "revoked"]),
  supersededByNoteId: z.string().nullable(),
  retiredAt: isoDateSchema,
});

const manifestSchema = z.object({
  version: z.literal(MEMORY_PACK_VERSION),
  origin: z.object({ fingerprint: fingerprintSchema, label: z.string() }),
  records: z.array(
    z.object({
      hash: sha256HexSchema,
      file: z.string(),
      originNoteId: z.string().min(1),
      textHash: sha256HexSchema,
    })
  ),
  // Cap the tombstone list (CODE-G): unbounded, ~10^5 tombstones fit a 16 MB
  // body and each drove sequential DB work. The export never emits a page above
  // this cap, so an honest pack is never refused for it.
  tombstones: z.array(tombstoneSchema).max(MEMORY_PACK_MAX_TOMBSTONES),
});

const packSchema = z.object({
  manifest: manifestSchema,
  records: z.array(
    z.object({ hash: sha256HexSchema, record: z.unknown().optional() })
  ),
});

// Anchor arrays are the HOSTILE surface (CODE-H): plain unbounded string arrays
// let a self-consistent record smuggle ~50k symbols past the digest into an
// `IN (...)` over SQLite's 32,766-bind-variable ceiling (uncaught throw, 500
// mid-pack). Mirror — and, for the pack surface, tighten past — the direct
// create route's caps, and bound each element's length.
const anchorArraySchema = z
  .array(z.string().min(1).max(512))
  .max(128);

const packRecordSchema = z.object({
  version: z.number(),
  origin: z.object({
    fingerprint: fingerprintSchema,
    noteId: z.string().min(1),
    label: z.string(),
  }),
  note: z.object({
    kind: z.enum(["decision", "constraint", "convention", "attempt", "question"]),
    text: z.string().min(1),
    textHash: sha256HexSchema,
    scope: z.string(),
    trust: z.string(),
    modules: anchorArraySchema,
    topics: anchorArraySchema,
    symbols: anchorArraySchema,
    validFrom: isoDateSchema,
    recordedAt: isoDateSchema,
  }),
  author: z.object({
    principal: z.string().min(1),
    kind: z.enum(["human", "agent"]),
  }),
  confirmation: z.object({
    principal: z.string().min(1),
    decision: z.string(),
    at: isoDateSchema,
    textHash: sha256HexSchema,
  }),
  supersededTextHashes: z.array(sha256HexSchema).max(256),
});

/** How many records one import request may carry (pack-level cap). Shared with
 *  the export side so a large workspace's paged export never dead-ends here. */
export const MEMORY_PACK_IMPORT_MAX_RECORDS = MEMORY_PACK_MAX_RECORDS;

export type MemoryPackImportReport = {
  origin: { fingerprint: string; label: string };
  /** New local proposal notes, sorted by recordHash asc. */
  proposed: { recordHash: string; noteId: string }[];
  /** Same content hash already HUMAN-confirmed locally → no-op, sorted by recordHash. */
  duplicatesOfConfirmed: { recordHash: string; noteId: string }[];
  /** Near-duplicate of a local UNCONFIRMED note (ledger NOOP), sorted by recordHash. */
  duplicates: { recordHash: string; noteId: string }[];
  /** Already imported via (originWorkspace, recordHash), sorted asc. */
  alreadyImported: string[];
  /** The deterministic conflict-review list, sorted by noteId asc. */
  conflicts: { noteId: string; withNoteId: string; edgeKind: string }[];
  /** Tombstone-driven stale review items, sorted by noteId asc. */
  revocations: { noteId: string; originNoteId: string; reason: string }[];
  /** Record-level refusals with reasons, sorted by recordHash asc. */
  refused: { recordHash: string; reason: string }[];
  counts: {
    records: number;
    proposed: number;
    duplicatesOfConfirmed: number;
    duplicates: number;
    alreadyImported: number;
    conflicts: number;
    revocations: number;
    refused: number;
  };
};

export type MemoryPackImportResult =
  | { ok: true; report: MemoryPackImportReport }
  | { ok: false; reason: string };

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const at = issue?.path?.length ? ` at ${issue.path.join(".")}` : "";
  return `${issue?.message ?? "invalid shape"}${at}`;
}

/** Latest HUMAN decision per note over an asc feed — the gate's derivation,
 *  applied to the duplicate-confirmed lookup without touching the frozen
 *  isConfirmed/deriveConfirmedSet surfaces. */
async function humanConfirmedIds(noteIds: string[]): Promise<Set<string>> {
  if (noteIds.length === 0) {
    return new Set();
  }
  const rows = await prisma.confirmation.findMany({
    where: { noteId: { in: noteIds } },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  const latest = new Map<string, boolean>();
  for (const row of rows) {
    if (!isHumanPrincipal(row.principal)) {
      continue;
    }
    if (row.decision !== "confirm" && row.decision !== "reject") {
      continue;
    }
    latest.set(row.noteId, row.decision === "confirm");
  }
  return new Set([...latest.entries()].filter(([, ok]) => ok).map(([id]) => id));
}

/** True when the pack's origin fingerprint is one of THIS brain's own
 *  workspaces (the server owns the salt, so only it can decide). */
async function isSelfPack(
  fingerprint: string,
  opts: { workspace?: string; dataDir?: string }
): Promise<boolean> {
  const candidates = new Set<string>([opts.workspace ?? process.cwd()]);
  const tasks = await prisma.task.findMany({
    where: { workspacePath: { not: null } },
    select: { workspacePath: true },
    distinct: ["workspacePath"],
  });
  for (const task of tasks) {
    if (task.workspacePath) {
      candidates.add(task.workspacePath);
    }
  }
  return [...candidates].some(
    (candidate) => workspaceFingerprint(candidate, opts.dataDir) === fingerprint
  );
}

type VerifiedRecord = {
  hash: string;
  record: z.infer<typeof packRecordSchema>;
  /** The text after the defense-in-depth redaction re-run — the ONLY text that
   *  may ever reach the ledger. */
  redactedText: string;
};

/** Record-level verification: refuse-with-reason, siblings unaffected.
 *  `budget` is the shared per-request redaction accumulator (SEC-4): the
 *  quadratic `redactSecrets` re-run is metered so one hostile import cannot
 *  monopolize the single-threaded event loop with unbounded aggregate work. */
function verifyRecord(
  entry: { hash: string; record?: unknown },
  originFingerprint: string,
  manifestHashes: Set<string>,
  budget: { used: number }
): { ok: true; verified: VerifiedRecord } | { ok: false; reason: string } {
  const parsed = packRecordSchema.safeParse(entry.record);
  if (!parsed.success) {
    return { ok: false, reason: `malformed record: ${firstIssue(parsed.error)}` };
  }
  const record = parsed.data;
  if (record.version !== MEMORY_PACK_VERSION) {
    return {
      ok: false,
      reason: `unsupported record version ${record.version}; re-export the pack`,
    };
  }
  if (record.origin.fingerprint !== originFingerprint) {
    return {
      ok: false,
      reason: "record origin fingerprint does not match the pack origin",
    };
  }
  if (!manifestHashes.has(entry.hash)) {
    return { ok: false, reason: "record is not listed in the pack manifest" };
  }
  if (recordHashOf(record as unknown as MemoryPackRecord) !== entry.hash) {
    return {
      ok: false,
      reason:
        "recordHash mismatch: the content address does not match the record bytes",
    };
  }
  if (record.note.text.length > MEMORY_PACK_MAX_TEXT_CHARS) {
    return {
      ok: false,
      reason: `text exceeds ${MEMORY_PACK_MAX_TEXT_CHARS} chars`,
    };
  }
  // SEC-4 aggregate redaction budget: meter total redaction input per request
  // BEFORE running the (quadratic) redactor, so no single import can hold the
  // event loop with unbounded aggregate work. The cap equals what one valid
  // paged export can contain, so an honest pack is never refused for it; a
  // hostile flat pack that blows past it refuses the overflow with a reason.
  if (budget.used + record.note.text.length > MEMORY_PACK_MAX_REDACTION_CHARS) {
    return {
      ok: false,
      reason: `aggregate redaction budget (${MEMORY_PACK_MAX_REDACTION_CHARS} chars) for this import is exhausted; split the import into smaller packs`,
    };
  }
  budget.used += record.note.text.length;
  // Defense-in-depth: re-run redaction over the incoming text. A pack built
  // correctly is a no-op; a redaction-CHANGING import means credential material
  // rode the pack, and the recompute below refuses it as a hash mismatch.
  // THE SAME composed redaction the exporter used. It must be identical and
  // machine-INDEPENDENT, because the check on the next line re-derives the content
  // address from it: a redaction that consulted this machine's hostname or
  // username would refuse every legitimate pack.
  const redactedText = redactForPack(record.note.text);
  if (computeMemoryTextHash(redactedText) !== record.note.textHash) {
    return {
      ok: false,
      reason:
        "textHash mismatch: the text does not match its confirmed content hash after redaction",
    };
  }
  if (record.confirmation.textHash !== record.note.textHash) {
    return {
      ok: false,
      reason: "confirmation is not bound to this record's text (textHash mismatch)",
    };
  }
  if (record.confirmation.decision !== "confirm") {
    return {
      ok: false,
      reason: `origin confirmation decision is "${record.confirmation.decision}", not a confirm — origin status can never mint local trust`,
    };
  }
  if (!isHumanPrincipal(record.confirmation.principal)) {
    return {
      ok: false,
      reason:
        "origin confirmation principal is not human — origin status can never mint local trust",
    };
  }
  return { ok: true, verified: { hash: entry.hash, record, redactedText } };
}

/**
 * Import a memory pack as PROPOSALS. Every accepted record lands as an
 * ordinary unconfirmed active note (structurally outside the gate); tombstones
 * land as set-once stale review flags. Deterministic: records are processed
 * sorted by recordHash asc, tombstones by originNoteId asc, and every report
 * array is sorted, so the same pack against the same brain always yields the
 * same review list.
 *
 * `opts.workspace` is the RECEIVING workspace — validated and `repoRootOf`-reduced
 * by the route — and it is the ONLY source of the local partition (ADR-0026 §7).
 * Absent, every proposal lands in §8's residue: operator-visible, agent-invisible,
 * and exportable by no workspace at all.
 */
export async function importMemoryPack(
  input: unknown,
  opts: { workspace?: string; dataDir?: string } = {}
): Promise<MemoryPackImportResult> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "malformed pack: not a JSON object" };
  }
  const rawVersion = (input as { manifest?: { version?: unknown } }).manifest
    ?.version;
  if (rawVersion !== MEMORY_PACK_VERSION) {
    return {
      ok: false,
      reason: `unsupported pack version ${String(rawVersion)}; re-export the pack with a MUON build that writes version ${MEMORY_PACK_VERSION}`,
    };
  }
  const parsed = packSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: `malformed pack: ${firstIssue(parsed.error)}` };
  }
  const { manifest, records } = parsed.data;
  if (
    records.length > MEMORY_PACK_IMPORT_MAX_RECORDS ||
    manifest.records.length > MEMORY_PACK_IMPORT_MAX_RECORDS
  ) {
    return {
      ok: false,
      reason: `pack carries more than ${MEMORY_PACK_IMPORT_MAX_RECORDS} records; split the import`,
    };
  }
  // packDigest over the sorted immutable projection — a tampered manifest
  // (record list / tombstones / origin) refuses the WHOLE pack.
  const recomputedDigest = packDigestOf(manifest);
  const claimedDigest = (input as { manifest: { packDigest?: unknown } }).manifest
    .packDigest;
  if (recomputedDigest !== claimedDigest) {
    return {
      ok: false,
      reason: `packDigest mismatch: the manifest does not match its recomputed digest (${recomputedDigest})`,
    };
  }
  if (await isSelfPack(manifest.origin.fingerprint, opts)) {
    return { ok: false, reason: "self-pack: this pack was exported by this workspace" };
  }

  // ADR-0026 §7 — the RECEIVING workspace, already validated
  // (`validateWorkspacePath`) and reduced (`repoRootOf`) by the route. Two
  // spellings of one value, because the note column and the key column disagree
  // about NULL:
  //   • `receivingWorkspace` (null when the caller named none) is the note's
  //     partition, and null means §8's residue — never a guess.
  //   • `receivingKey` is the non-null half of the idempotence key. The column is
  //     `NOT NULL DEFAULT ''` on purpose: SQLite treats every NULL in a UNIQUE
  //     index as DISTINCT, so a nullable column would disable the very constraint
  //     the claim-first flow below reads as "already imported".
  const receivingWorkspace = opts.workspace ?? null;
  const receivingKey = receivingWorkspace ?? "";

  const manifestHashes = new Set(manifest.records.map((entry) => entry.hash));
  const proposed: { recordHash: string; noteId: string }[] = [];
  const duplicatesOfConfirmed: { recordHash: string; noteId: string }[] = [];
  const duplicates: { recordHash: string; noteId: string }[] = [];
  const alreadyImported: string[] = [];
  const conflicts: { noteId: string; withNoteId: string; edgeKind: string }[] = [];
  const revocations: { noteId: string; originNoteId: string; reason: string }[] = [];
  const refused: { recordHash: string; reason: string }[] = [];

  const budget = { used: 0 };
  const sortedEntries = [...records].sort((a, b) => (a.hash < b.hash ? -1 : 1));
  for (const entry of sortedEntries) {
    const verdict = verifyRecord(
      entry,
      manifest.origin.fingerprint,
      manifestHashes,
      budget
    );
    if (!verdict.ok) {
      refused.push({ recordHash: entry.hash, reason: verdict.reason });
      continue;
    }
    const { record, redactedText } = verdict.verified;

    // 1. Idempotence-row-FIRST (CODE-D): CLAIM the (originWorkspace, recordHash)
    //    unique row BEFORE any ingest, as `pending` with noteId:null. The unique
    //    constraint is then the real gate: a concurrent duplicate import (or a
    //    re-import) hits P2002 here and skips WITHOUT ingesting, so it can never
    //    insert an orphan proposal note or double-count a record across report
    //    categories. The note id + true disposition are stamped in after ingest.
    //
    //    ADR-0026 §7: the claim is per-(origin, RECEIVING) workspace, so the same
    //    pack imported into a second local workspace claims a DIFFERENT row and
    //    proposes again. Every subsequent lookup in this function carries the same
    //    receiving term — a query that omitted it would reach across the partition
    //    it just created (and the release path below would drop another
    //    workspace's claim).
    try {
      await prisma.memoryImport.create({
        data: {
          originWorkspace: manifest.origin.fingerprint,
          receivingWorkspace: receivingKey,
          originLabel: manifest.origin.label,
          originNoteId: record.origin.noteId,
          recordHash: entry.hash,
          textHash: record.note.textHash,
          noteId: null,
          disposition: "pending",
          originAuthor: record.author.principal,
          originConfirmedBy: record.confirmation.principal,
          originConfirmedAt: new Date(record.confirmation.at),
        },
      });
    } catch (error) {
      // Already imported, or a concurrent duplicate won the claim — degrade-safe,
      // this record counts as already imported and is NOT ingested again.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        alreadyImported.push(entry.hash);
        continue;
      }
      throw error;
    }

    // 2..3. With the claim held, resolve the note id + disposition. Any storage
    //    error mid-ingest (CODE-P) drops the claim and refuses THIS record while
    //    honest siblings proceed — no partial/orphan state, no lost report.
    let disposition: string;
    let noteId: string | null;
    try {
      // 2. Same content hash already HUMAN-confirmed locally → no-op (the fact is
      //    already in the moat; nothing to propose). The claim row keeps
      //    disposition `duplicate-confirmed` so the tombstone pass NEVER treats a
      //    local, never-imported, human-confirmed note as an imported proposal
      //    (SEC-2).
      const sameText = await prisma.memoryNote.findMany({
        where: {
          textHash: record.note.textHash,
          status: "active",
          // ADR-0026 §7/§9 + TODO 4.15 — third copy of the dedup rule (pack path).
          // Same ALWAYS-fence as `findExactTextDuplicate` /
          // `anchorScopedCandidates`: `null` receiving workspace matches residue
          // only. Unpartitioned, repo A having confirmed this sentence made
          // repo B's import a no-op pointing at repo A's note.
          workspacePath: receivingWorkspace ?? null,
        },
        select: { id: true },
      });
      const confirmedIds = await humanConfirmedIds(sameText.map((row) => row.id));
      const confirmedLocal = sameText.find((row) => confirmedIds.has(row.id));

      if (confirmedLocal) {
        disposition = "duplicate-confirmed";
        noteId = confirmedLocal.id;
        duplicatesOfConfirmed.push({ recordHash: entry.hash, noteId });
      } else {
        // 3. The full dedup/conflict machinery, staged: proposalOnly forces every
        //    destructive verdict through the non-destructive branches, and the
        //    origin author/trust are provenance DATA — the note lands low-trust,
        //    authored by the pack principal, NEVER by the origin human.
        //
        //    ADR-0026 §7 — THE STAMP, and step 1 of the break's chain. Before it,
        //    an imported note landed `workspacePath` NULL, the export deny-list
        //    read NULL as "in every workspace", and one local confirm re-exported
        //    it into every workspace's pack. The partition is the RECEIVING
        //    workspace and is read from `opts.workspace` alone: the pack's contents
        //    can carry any string they like and none of them reaches this field.
        //
        //    D1 CONSEQUENCE, stated rather than discovered: with a workspace on the
        //    input, `ingestMemoryNote` now obtains the RECEIVING repo's tracked-file
        //    set, so an imported coordinate lands `resolved`/`unresolved` where it
        //    previously always landed NULL. That is the honest reading of the
        //    column — `unresolved` asserts "not in THIS partition's tracked set",
        //    which is a set we actually hold, and this note now belongs to this
        //    partition. It says nothing about the origin repository, which this
        //    machine may not even have. An import with no receiving workspace keeps
        //    the old NULL, because there is no set to hold. Still no
        //    `plannedCoordinates` — a pack must not be able to declare anything
        //    about this workspace.
        const noteInput: MemoryNoteInput = {
          kind: record.note.kind,
          text: redactedText,
          modules: record.note.modules,
          topics: record.note.topics,
          symbols: record.note.symbols,
          scope: "project",
          trust: "low",
          createdBy: `pack:${manifest.origin.fingerprint}`,
          workspacePath: receivingWorkspace,
          proposalOnly: true,
        };
        // P0-2: NEVER auto-vouched. The orchestrator vouches for what THIS crew
        // learned; a pack is a foreign workspace's claims, and the invariant
        // above ("NO Confirmation row is ever written here") is what keeps an
        // import invisible to agent slices until a human HERE admits it.
        const result = await ingestMemoryNote(noteInput, {
          orchestratorConfirm: false,
        });
        noteId = result.note.id;
        switch (result.action) {
          case "duplicate":
            disposition = "duplicate";
            duplicates.push({ recordHash: entry.hash, noteId });
            break;
          case "conflict":
            disposition = "conflict";
            proposed.push({ recordHash: entry.hash, noteId });
            if (result.relatedNoteId) {
              conflicts.push({
                noteId,
                withNoteId: result.relatedNoteId,
                edgeKind: "contradicts",
              });
            }
            break;
          case "related":
            disposition = "related";
            proposed.push({ recordHash: entry.hash, noteId });
            if (result.relatedNoteId) {
              conflicts.push({
                noteId,
                withNoteId: result.relatedNoteId,
                edgeKind: "related",
              });
            }
            break;
          case "proposed":
            disposition = "proposed-supersede";
            proposed.push({ recordHash: entry.hash, noteId });
            if (result.relatedNoteId) {
              conflicts.push({
                noteId,
                withNoteId: result.relatedNoteId,
                edgeKind: "proposes_supersede",
              });
            }
            break;
          default:
            // "inserted" — a plain new proposal. ("superseded" is structurally
            // unreachable under proposalOnly.)
            disposition = "proposed";
            proposed.push({ recordHash: entry.hash, noteId });
            break;
        }
      }
    } catch (error) {
      // CODE-P: release the pending claim so a later re-import can retry this
      // record, and refuse it with a stated reason. Honest siblings continue.
      await prisma.memoryImport
        .deleteMany({
          where: {
            originWorkspace: manifest.origin.fingerprint,
            // ADR-0026 §7: the receiving term is what keeps this release scoped to
            // the claim THIS import made. Without it, a failed import into repo B
            // would delete repo A's healthy claim for the same record and A's
            // proposal would re-import as a duplicate on the next sync.
            receivingWorkspace: receivingKey,
            recordHash: entry.hash,
          },
        })
        .catch(() => undefined);
      refused.push({
        recordHash: entry.hash,
        reason: `storage error while ingesting the record: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      continue;
    }

    // 4. Stamp the claimed row with the real note id + resolved disposition.
    //
    // ADR-0026 §7 widened the idempotence key to
    // `(originWorkspace, receivingWorkspace, recordHash)` so re-importing one
    // pack into a SECOND local workspace produces a second set of proposals
    // instead of being swallowed as `alreadyImported`. This addresses the row the
    // claim above created, so the receiving term must be the SAME `receivingKey`
    // — an import with no receiving workspace still addresses the '' row and
    // behaves exactly as it did before step 5.
    await prisma.memoryImport.update({
      where: {
        originWorkspace_receivingWorkspace_recordHash: {
          originWorkspace: manifest.origin.fingerprint,
          receivingWorkspace: receivingKey,
          recordHash: entry.hash,
        },
      },
      data: { noteId, disposition },
    });
  }

  // Tombstones: revocation/supersession propagate as SET-ONCE stale review
  // items on notes that ORIGINATED AS IMPORTED PROPOSALS from this origin —
  // never a retire, and never a touch on a foreign / never-imported / LOCAL
  // human-confirmed note.
  //
  // SEC-2: the linkage is confined by disposition. `duplicate-confirmed` (points
  // at a LOCAL human-confirmed note the import merely deduped against) and
  // `duplicate` (points at a LOCAL unconfirmed near-duplicate) are EXCLUDED, so
  // a foreign pack can never stale a note it did not itself create. Without this
  // filter, a pack whose text matched a local confirmed note L plus a tombstone
  // for it would demote L out of every agent slice — an authority inversion on
  // the confirmed-only moat.
  const sortedTombstones = [...manifest.tombstones].sort((a, b) =>
    a.originNoteId < b.originNoteId ? -1 : 1
  );
  // Batched lookup (CODE-G): one query for every tombstone's origin note id
  // instead of one round-trip per tombstone.
  const tombstoneOriginIds = [
    ...new Set(sortedTombstones.map((tombstone) => tombstone.originNoteId)),
  ];
  const mappedRows =
    tombstoneOriginIds.length === 0
      ? []
      : await prisma.memoryImport.findMany({
          where: {
            originWorkspace: manifest.origin.fingerprint,
            // ADR-0026 §7: a tombstone may only reach the proposals THIS receiving
            // workspace imported. The same pack imported into repo A and repo B
            // now has a row per partition, and revocation is a partitioned act:
            // syncing repo B must not stale repo A's copy of the fact, which its
            // own human confirmed under its own review queue.
            receivingWorkspace: receivingKey,
            originNoteId: { in: tombstoneOriginIds },
            noteId: { not: null },
            disposition: { notIn: ["duplicate-confirmed", "duplicate"] },
          },
          select: { originNoteId: true, noteId: true },
        });
  const noteIdsByOrigin = new Map<string, Set<string>>();
  for (const row of mappedRows) {
    if (!row.noteId) {
      continue;
    }
    const set = noteIdsByOrigin.get(row.originNoteId) ?? new Set<string>();
    set.add(row.noteId);
    noteIdsByOrigin.set(row.originNoteId, set);
  }
  for (const tombstone of sortedTombstones) {
    const noteIds = [
      ...(noteIdsByOrigin.get(tombstone.originNoteId) ?? new Set<string>()),
    ].sort();
    for (const noteId of noteIds) {
      const updated = await prisma.memoryNote.updateMany({
        where: { id: noteId, status: "active", staleSince: null },
        data: { staleSince: new Date(tombstone.retiredAt) },
      });
      if (updated.count !== 1) {
        continue; // already stale / retired / gone → set-once no-op
      }
      await prisma.confirmation.create({
        data: { noteId, principal: "system", decision: "reconcile" },
      });
      await prisma.memoryImport.updateMany({
        where: {
          originWorkspace: manifest.origin.fingerprint,
          // ADR-0026 §7: same partition scope as the batched match above. The flip
          // is a fact about what happened to THIS workspace's proposal.
          receivingWorkspace: receivingKey,
          originNoteId: tombstone.originNoteId,
          // SEC-2 (residual): the flip carries the SAME provenance guard as the
          // batched match above — it may NEVER rewrite a `duplicate-confirmed`
          // (points at a LOCAL human-confirmed note) or `duplicate` (LOCAL
          // unconfirmed) marker to `revoked-at-origin`. Without it, a decoy proposal
          // sharing this origin.noteId flips the protective marker on the confirmed
          // note's row, so a later re-sync's batched match would find that row
          // un-excluded and stale the local confirmed note — an authority inversion
          // on the confirmed-only moat, reachable with one decoy plus a second sync.
          disposition: { notIn: ["duplicate-confirmed", "duplicate"] },
        },
        data: { disposition: "revoked-at-origin" },
      });
      revocations.push({
        noteId,
        originNoteId: tombstone.originNoteId,
        reason: tombstone.reason,
      });
      mirrorToGraph(async (graph) => {
        const note = await getMemoryNote(noteId);
        if (note) {
          await graph.projectMemoryNote(note);
        }
      });
    }
  }

  const byRecordHash = (
    a: { recordHash: string },
    b: { recordHash: string }
  ): number => (a.recordHash < b.recordHash ? -1 : a.recordHash > b.recordHash ? 1 : 0);
  const byNoteId = (a: { noteId: string }, b: { noteId: string }): number =>
    a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0;
  proposed.sort(byRecordHash);
  duplicatesOfConfirmed.sort(byRecordHash);
  duplicates.sort(byRecordHash);
  alreadyImported.sort();
  conflicts.sort(byNoteId);
  revocations.sort(byNoteId);
  refused.sort(byRecordHash);

  return {
    ok: true,
    report: {
      origin: manifest.origin,
      proposed,
      duplicatesOfConfirmed,
      duplicates,
      alreadyImported,
      conflicts,
      revocations,
      refused,
      counts: {
        records: records.length,
        proposed: proposed.length,
        duplicatesOfConfirmed: duplicatesOfConfirmed.length,
        duplicates: duplicates.length,
        alreadyImported: alreadyImported.length,
        conflicts: conflicts.length,
        revocations: revocations.length,
        refused: refused.length,
      },
    },
  };
}
