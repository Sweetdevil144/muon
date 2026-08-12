import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MemoryNote as MemoryNoteRow } from "@prisma/client";
import { redactForPack } from "@muon/client";
import { resolveDataDir } from "@muon/client/paths";
import { isHumanPrincipal } from "./auth.js";
import { prisma } from "./db.js";
import { computeMemoryTextHash } from "./memory-ledger.js";

// ── P1.4 Slice 1: workspace memory PACKS (export side) ──────────────────────
//
// A pack is the FILE transport for the confirmed-memory moat: a directory of
// per-record content-addressed JSON files plus one manifest, per origin
// workspace, written into a user-chosen store dir (which may live inside a team
// git repo — MUON itself runs no git and opens no network surface). Everything
// here is a pure projection of the durable ledger:
//
//   • CONFIRMED-ONLY: only status:"active" notes whose latest HUMAN
//     Confirmation is a confirm are exported. Unconfirmed / agent-"confirmed" /
//     rejected-never-confirmed / private:*-or-lane:*-scoped / another
//     workspace's / workspace-unassigned notes are excluded, each as a COUNTED,
//     honest omission.
//   • REDACT-BEFORE-SERIALIZE: every exported text passes redactForPack (the
//     shared @muon/client redactor — no third mirror) before any byte is
//     hashed or serialized, so credential material can never ride a pack.
//   • OMIT, DON'T TRUNCATE (deliberate deviation from the run-bundle
//     redact-then-truncate stance): a confirmed note whose redacted text
//     exceeds MEMORY_PACK_MAX_TEXT_CHARS is omitted with a reason. Truncation
//     would corrupt a confirmed fact and break the confirmation⇔content hash
//     binding, so it is never an option here.
//   • CONTENT-ADDRESSED + DETERMINISTIC: recordHash = sha256 of the record's
//     canonical JSON (its own filename); packDigest = sha256 over the sorted
//     immutable projection (the computeLineageDigest stance). No export
//     timestamp exists anywhere, and every array is sorted, so re-exporting an
//     unchanged brain is byte-identical (clean git diffs).
//   • TOMBSTONES carry revocation/supersession: every rejected note whose
//     Confirmation history contains a human confirm (it once crossed the gate
//     and could have been previously exported) emits one, derived purely from
//     the retire-never-delete ledger.
//   • WORKSPACE BOUNDARY (ADR-0026 §7, step 5): a note is exportable IFF its own
//     `MemoryNote.workspacePath` EQUALS the exporting workspace. An ALLOW-list,
//     evaluated ahead of the tombstone branch so a foreign note never leaves —
//     not even as a TOMBSTONE. NULL (§8's unassigned residue) is NOT exportable,
//     and is counted under its OWN reason: "withheld because unassigned" must be
//     distinguishable from "withheld because it belongs to another repo", and
//     neither may read as "there was nothing to export".
//     REJECTED — and this is what shipped until step 5: the `taskId →
//     Task.workspacePath` DENY-list ("in-workspace unless the task resolves
//     outside"), fail-OPEN on three NULL paths (no taskId, pruned Task, NULL
//     Task.workspacePath). Import stamped no taskId, so every imported note was
//     in-workspace for EVERY workspace on the machine, and one local human
//     confirm then re-exported another repo's memory into this one's pack — a
//     confidentiality break across a machine boundary, into a directory the user
//     is told to commit. The join survives only as 0041's backfill witness and is
//     no longer a runtime boundary.
//     ALSO REJECTED: containment (`isWithin`) rather than equality. Both sides are
//     a single canonical repo root (`repoRootOf`, reduced at the route), so
//     containment could only ever ADMIT more than the partition — a nested repo's
//     notes leaving inside the parent's pack — and this filter is a narrower.
//     taskId/laneId are machine-local cuids and are DROPPED from records
//     (module/topic/symbol anchors are workspace-relative posix and portable);
//     `workspacePath` is an absolute LOCAL path and is never serialized either —
//     `canonicalRecordJson` rebuilds a record field-by-field, so the only
//     workspace value on the wire is the salted opaque origin fingerprint.
//
// Import (Slice 2) NEVER trusts any of this: every field is re-verified
// server-side and an imported record lands as an unconfirmed proposal.

export const MEMORY_PACK_VERSION = 1 as const;
export const MEMORY_PACK_MANIFEST_NAME = "muon-memory-pack.json";
export const MEMORY_PACK_MAX_TEXT_CHARS = 10_000;
export const PACK_SALT_FILE = "pack-salt";

// ── shared record/tombstone/redaction bounds (CODE-E / CODE-G / SEC-4) ────────
//
// Export and import MUST agree on the same caps or team-sync dead-ends (a
// workspace that exports more than the importer accepts can never sync). These
// live here as the single source of truth; the import side re-uses them, and
// the export splits a large workspace into deterministic PAGES that each honor
// them, so a 501+-note (or high-volume) brain still exports importably.
//
//   • MEMORY_PACK_MAX_RECORDS   — max records per pack/page (import refuses more).
//   • MEMORY_PACK_MAX_TOMBSTONES — max tombstones per pack/page (was unbounded:
//     ~10^5 per 16 MB body drove that many sequential DB round-trips).
//   • MEMORY_PACK_MAX_REDACTION_CHARS — aggregate redaction-input budget per
//     import request AND per export page. Bounds how much redactSecrets work one
//     request can force onto the single-threaded loop (SEC-4), and — because the
//     export never emits a page above it — it never refuses an honest pack.
export const MEMORY_PACK_MAX_RECORDS = 500;
export const MEMORY_PACK_MAX_TOMBSTONES = 500;
export const MEMORY_PACK_MAX_REDACTION_CHARS = 500_000;

export type MemoryPackOrigin = {
  /** Opaque salted workspace identity: `ws-` + 16 hex. No path/host leaves. */
  fingerprint: string;
  /** Human-readable name: basename of the workspace path, nothing more. */
  label: string;
};

export type MemoryPackRecord = {
  version: typeof MEMORY_PACK_VERSION;
  origin: { fingerprint: string; noteId: string; label: string };
  note: {
    kind: string;
    text: string;
    textHash: string;
    scope: string;
    trust: string;
    modules: string[];
    topics: string[];
    symbols: string[];
    validFrom: string;
    recordedAt: string;
  };
  author: { principal: string; kind: "human" | "agent" };
  confirmation: {
    principal: string;
    decision: "confirm";
    at: string;
    textHash: string;
  };
  supersededTextHashes: string[];
};

export type MemoryPackManifestRecord = {
  hash: string;
  file: string;
  originNoteId: string;
  textHash: string;
};

export type MemoryPackTombstone = {
  originNoteId: string;
  textHash: string;
  reason: "superseded" | "revoked";
  supersededByNoteId: string | null;
  retiredAt: string;
};

export type MemoryPackManifest = {
  version: typeof MEMORY_PACK_VERSION;
  origin: MemoryPackOrigin;
  counts: {
    /** Records carried by THIS page. */
    records: number;
    /** Tombstones carried by THIS page. */
    tombstones: number;
    /** Notes excluded from the whole export (global, repeated on every page). */
    omitted: number;
    /** 0-based index of this page within the export. */
    page: number;
    /** Total pages the export splits into (1 when it fits in one pack). */
    pageCount: number;
    /** Total records across ALL pages (page-independent). */
    totalRecords: number;
    /** Total tombstones across ALL pages (page-independent). */
    totalTombstones: number;
  };
  records: MemoryPackManifestRecord[];
  tombstones: MemoryPackTombstone[];
  omissions: string[];
  invariants: {
    confirmedOnly: true;
    unconfirmedTextExcluded: true;
    secretsRedactedBeforeWrite: true;
    noCredentialMaterial: true;
  };
  packDigest: string;
};

export type MemoryPackExport = {
  manifest: MemoryPackManifest;
  records: { hash: string; record: MemoryPackRecord }[];
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

// ── origin fingerprint ───────────────────────────────────────────────────────

/**
 * Read (or mint once) the per-brain pack salt: 32 random hex bytes at
 * `<dataDir>/pack-salt`, 0600, written atomically temp-then-rename (the
 * paths.ts lockfile stance). The salt keeps the fingerprint OPAQUE: no
 * workspace path, hostname, or username ever leaves the machine.
 */
export function readOrMintPackSalt(dataDir: string = resolveDataDir()): string {
  const target = path.join(dataDir, PACK_SALT_FILE);
  try {
    const existing = fs.readFileSync(target, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      return existing;
    }
  } catch {
    // missing/unreadable → mint below
  }
  const salt = randomBytes(32).toString("hex");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${salt}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return salt;
}

/** `ws-` + first 16 hex of sha256(salt + "\n" + validated workspace path). */
export function workspaceFingerprint(
  workspacePath: string,
  dataDir?: string
): string {
  const salt = readOrMintPackSalt(dataDir);
  return `ws-${sha256Hex(`${salt}\n${workspacePath}`).slice(0, 16)}`;
}

// ── canonical serialization + content addressing ─────────────────────────────

/**
 * Canonical JSON of one record: FIXED field order, no whitespace variance,
 * rebuilt field-by-field so a caller-supplied object with reordered keys (a
 * parsed pack file on the import side) still canonicalizes identically.
 */
export function canonicalRecordJson(record: MemoryPackRecord): string {
  const canonical: MemoryPackRecord = {
    version: record.version,
    origin: {
      fingerprint: record.origin.fingerprint,
      noteId: record.origin.noteId,
      label: record.origin.label,
    },
    note: {
      kind: record.note.kind,
      text: record.note.text,
      textHash: record.note.textHash,
      scope: record.note.scope,
      trust: record.note.trust,
      modules: [...record.note.modules],
      topics: [...record.note.topics],
      symbols: [...record.note.symbols],
      validFrom: record.note.validFrom,
      recordedAt: record.note.recordedAt,
    },
    author: { principal: record.author.principal, kind: record.author.kind },
    confirmation: {
      principal: record.confirmation.principal,
      decision: record.confirmation.decision,
      at: record.confirmation.at,
      textHash: record.confirmation.textHash,
    },
    supersededTextHashes: [...record.supersededTextHashes],
  };
  return JSON.stringify(canonical);
}

/** Content-addressed record identity: sha256 of the canonical JSON. */
export function recordHashOf(record: MemoryPackRecord): string {
  return sha256Hex(canonicalRecordJson(record));
}

/**
 * Pack digest over the sorted IMMUTABLE projection only (the
 * computeLineageDigest stance): version, origin fingerprint, the record hash
 * list, and the tombstones. Counts/omissions/label are presentation and stay
 * out, so the digest is recomputable from the manifest alone.
 */
export function packDigestOf(
  manifest: Pick<MemoryPackManifest, "version" | "origin" | "records" | "tombstones">
): string {
  return sha256Hex(
    JSON.stringify({
      version: manifest.version,
      origin: { fingerprint: manifest.origin.fingerprint },
      records: manifest.records.map((record) => record.hash),
      tombstones: manifest.tombstones.map((tombstone) => ({
        originNoteId: tombstone.originNoteId,
        textHash: tombstone.textHash,
        reason: tombstone.reason,
        supersededByNoteId: tombstone.supersededByNoteId,
        retiredAt: tombstone.retiredAt,
      })),
    })
  );
}

// ── pure pack builder ────────────────────────────────────────────────────────

export type MemoryPackConfirmationRow = {
  noteId: string;
  principal: string;
  decision: string;
  at: Date;
};

export type MemoryPackSource = {
  /**
   * The exporting workspace: an absolute path already VALIDATED
   * (`validateWorkspacePath`) and already REDUCED (`repoRootOf`) by the route.
   *
   * Reduced there and not here, because `repoRootOf` is async (a `git` probe) and
   * this builder is pure + synchronous — and because the read routes reduce in the
   * same place, through the same evaluator. A second reduction site is how one
   * surface ends up disagreeing with the writer about what a workspace is.
   */
  workspacePath: string;
  origin: MemoryPackOrigin;
  notes: MemoryNoteRow[];
  /** Full Confirmation feed, ascending by `at` (sorted defensively anyway). */
  confirmations: MemoryPackConfirmationRow[];
};

type ConfirmationState = {
  /** Latest HUMAN decision is "confirm" — the gate's derivation, mirrored. */
  confirmedNow: boolean;
  /** Any human confirm exists in history (it once crossed the gate). */
  everConfirmed: boolean;
  /** Latest human CONFIRM row (the one exported as the confirmation). */
  latestConfirm: MemoryPackConfirmationRow | null;
};

/** Derive per-note confirmation state with deriveConfirmedSet semantics: only
 *  HUMAN principals count; "reconcile"/system/agent rows are inert. */
function deriveConfirmationStates(
  confirmations: MemoryPackConfirmationRow[]
): Map<string, ConfirmationState> {
  const sorted = [...confirmations].sort(
    (a, b) => a.at.getTime() - b.at.getTime()
  );
  const states = new Map<string, ConfirmationState>();
  for (const row of sorted) {
    if (!isHumanPrincipal(row.principal)) {
      continue;
    }
    if (row.decision !== "confirm" && row.decision !== "reject") {
      continue;
    }
    const state =
      states.get(row.noteId) ??
      ({ confirmedNow: false, everConfirmed: false, latestConfirm: null } as ConfirmationState);
    if (row.decision === "confirm") {
      state.confirmedNow = true;
      state.everConfirmed = true;
      state.latestConfirm = row;
    } else {
      state.confirmedNow = false;
    }
    states.set(row.noteId, state);
  }
  return states;
}

/** Omission reason taxonomy (stable strings — they land in the manifest). */
const OMISSION = {
  notConfirmed: "not human-confirmed",
  paused: "paused by the local operator",
  rejectedNeverConfirmed: "rejected without a prior human confirmation",
  scopePrivate: "scope private:*",
  scopeLane: "scope lane:*",
  // ADR-0026 §7/§8 — TWO reasons, deliberately, because the allow-predicate
  // withholds for two different facts and an operator has to be able to tell them
  // apart: "this belongs to another repo" is a partition answer, "this was never
  // assigned to a repo" is a review debt the operator can settle (§11's
  // backfill-workspace re-run, or a hand assignment from the review queue). One
  // merged reason would make the residue look like a foreign repo's memory, and a
  // SILENT drop would read as "there was nothing to export".
  otherWorkspace: "belongs to another workspace",
  unassignedWorkspace: "not assigned to a workspace (unscoped residue)",
  oversize: `text exceeds ${MEMORY_PACK_MAX_TEXT_CHARS} chars`,
} as const;

/**
 * Assemble one PAGE's manifest+records from an already-computed, already-sorted
 * slice. Kept separate so `buildMemoryPack` can page a large workspace into
 * several importable packs that each carry their own manifest + recomputable
 * packDigest (the digest is over that page's record hashes + tombstones only).
 */
function assemblePage(
  origin: MemoryPackOrigin,
  pageRecords: { hash: string; record: MemoryPackRecord }[],
  pageTombstones: MemoryPackTombstone[],
  omissions: string[],
  omitted: number,
  pageInfo: {
    page: number;
    pageCount: number;
    totalRecords: number;
    totalTombstones: number;
  }
): MemoryPackExport {
  const manifestCore = {
    version: MEMORY_PACK_VERSION,
    origin,
    records: pageRecords.map(({ hash, record }) => ({
      hash,
      file: `records/${hash}.json`,
      originNoteId: record.origin.noteId,
      textHash: record.note.textHash,
    })),
    tombstones: pageTombstones,
  };
  const manifest: MemoryPackManifest = {
    version: MEMORY_PACK_VERSION,
    origin,
    counts: {
      records: pageRecords.length,
      tombstones: pageTombstones.length,
      omitted,
      page: pageInfo.page,
      pageCount: pageInfo.pageCount,
      totalRecords: pageInfo.totalRecords,
      totalTombstones: pageInfo.totalTombstones,
    },
    records: manifestCore.records,
    tombstones: pageTombstones,
    omissions,
    invariants: {
      confirmedOnly: true,
      unconfirmedTextExcluded: true,
      secretsRedactedBeforeWrite: true,
      noCredentialMaterial: true,
    },
    packDigest: packDigestOf(manifestCore),
  };
  return { manifest, records: pageRecords };
}

/**
 * Split the full sorted record/tombstone lists into deterministic pages. A page
 * closes when adding the next record would exceed EITHER the record cap OR the
 * aggregate redaction-char budget (so no page can ever exceed what the importer
 * accepts — CODE-E). Tombstones chunk by the tombstone cap and ride alongside
 * the record pages; if there are more tombstone-chunks than record-pages, the
 * extra chunks get their own trailing pages. Ordering is preserved throughout.
 */
function paginate(
  records: { hash: string; record: MemoryPackRecord; chars: number }[],
  tombstones: MemoryPackTombstone[]
): {
  records: { hash: string; record: MemoryPackRecord }[];
  tombstones: MemoryPackTombstone[];
}[] {
  const recordPages: { hash: string; record: MemoryPackRecord }[][] = [];
  let current: { hash: string; record: MemoryPackRecord }[] = [];
  let chars = 0;
  for (const entry of records) {
    const wouldOverflow =
      current.length >= MEMORY_PACK_MAX_RECORDS ||
      (current.length > 0 && chars + entry.chars > MEMORY_PACK_MAX_REDACTION_CHARS);
    if (wouldOverflow) {
      recordPages.push(current);
      current = [];
      chars = 0;
    }
    current.push({ hash: entry.hash, record: entry.record });
    chars += entry.chars;
  }
  if (current.length > 0 || recordPages.length === 0) {
    recordPages.push(current);
  }
  const tombPages: MemoryPackTombstone[][] = [];
  for (let i = 0; i < tombstones.length; i += MEMORY_PACK_MAX_TOMBSTONES) {
    tombPages.push(tombstones.slice(i, i + MEMORY_PACK_MAX_TOMBSTONES));
  }
  const pageCount = Math.max(recordPages.length, tombPages.length, 1);
  const pages: {
    records: { hash: string; record: MemoryPackRecord }[];
    tombstones: MemoryPackTombstone[];
  }[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    pages.push({
      records: recordPages[i] ?? [],
      tombstones: tombPages[i] ?? [],
    });
  }
  return pages;
}

/**
 * Build the whole pack from ledger rows. PURE and deterministic: no clock, no
 * I/O, every array sorted, so identical rows always produce identical bytes.
 *
 * A large workspace is split into `pageCount` importable pages, each honoring
 * the shared caps (records / tombstones / redaction chars); `opts.page` selects
 * which page to materialize (default 0). `buildMemoryPackPages` returns them
 * all. Team sync therefore never dead-ends on a 501+-note brain.
 */
export function buildMemoryPack(
  source: MemoryPackSource,
  opts: { page?: number } = {}
): MemoryPackExport {
  const pages = buildMemoryPackPages(source);
  const page = Math.min(Math.max(opts.page ?? 0, 0), pages.length - 1);
  return pages[page];
}

/** Every page of the export, in order (at least one, possibly empty, page). */
export function buildMemoryPackPages(source: MemoryPackSource): MemoryPackExport[] {
  const states = deriveConfirmationStates(source.confirmations);
  const emptyState: ConfirmationState = {
    confirmedNow: false,
    everConfirmed: false,
    latestConfirm: null,
  };

  // supersession chains: successor id → retired predecessor rows.
  const predecessorsBySuccessor = new Map<string, MemoryNoteRow[]>();
  for (const row of source.notes) {
    if (row.supersededBy) {
      const list = predecessorsBySuccessor.get(row.supersededBy) ?? [];
      list.push(row);
      predecessorsBySuccessor.set(row.supersededBy, list);
    }
  }
  const supersededHashesFor = (noteId: string): string[] => {
    const hashes: string[] = [];
    const visited = new Set<string>([noteId]);
    const queue = [...(predecessorsBySuccessor.get(noteId) ?? [])];
    while (queue.length > 0) {
      const predecessor = queue.shift()!;
      if (visited.has(predecessor.id)) {
        continue; // cycle guard — a corrupt chain must not hang the export
      }
      visited.add(predecessor.id);
      hashes.push(predecessor.textHash);
      queue.push(...(predecessorsBySuccessor.get(predecessor.id) ?? []));
    }
    return sortedUnique(hashes);
  };

  const scopeAllowed = (scope: string) => scope === "project" || scope === "global";
  const scopeOmission = (scope: string): string => {
    if (scope.startsWith("private:")) return OMISSION.scopePrivate;
    if (scope.startsWith("lane:")) return OMISSION.scopeLane;
    return `scope ${scope}`;
  };
  /**
   * ADR-0026 §7 — the export boundary, as an ALLOW-predicate on the note's OWN
   * partition. `null` = exportable; a string = the reason it is withheld.
   *
   * EQUALITY, not containment, and no NULL branch that admits: both sides are the
   * same canonical repo root (the write path stored `repoRootOf(...)`, the route
   * reduced this one the same way), so equality is exactly the partition. Every
   * other shape this predicate could take is a widener, and the deny-list it
   * replaces was a widener on three NULL paths (see the module header).
   */
  const workspaceOmission = (notePartition: string | null): string | null => {
    if (notePartition === null) {
      return OMISSION.unassignedWorkspace;
    }
    return notePartition === source.workspacePath
      ? null
      : OMISSION.otherWorkspace;
  };

  const omissionCounts = new Map<string, number>();
  const omit = (reason: string) => {
    omissionCounts.set(reason, (omissionCounts.get(reason) ?? 0) + 1);
  };

  const records: { hash: string; record: MemoryPackRecord; chars: number }[] = [];
  const tombstones: MemoryPackTombstone[] = [];

  for (const row of [...source.notes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const state = states.get(row.id) ?? emptyState;
    // Hard export boundary FIRST: private/lane scopes and out-of-partition notes
    // never leave, not even as tombstones (they were never exportable, so there is
    // nothing for the receiving side to revoke). Keeping this AHEAD of the rejected
    // branch below is the ordering property, not an accident: a tombstone carries a
    // foreign note's id + textHash, which is itself the existence of another repo's
    // memory crossing the machine boundary.
    if (!scopeAllowed(row.scope)) {
      omit(scopeOmission(row.scope));
      continue;
    }
    const withheld = workspaceOmission(row.workspacePath);
    if (withheld) {
      omit(withheld);
      continue;
    }
    // A pause is local operator state, not a revocation and not portable crew
    // authority. It exports neither text nor tombstone; resume makes the same
    // durable human confirmation exportable again.
    if (row.status === "paused") {
      omit(OMISSION.paused);
      continue;
    }
    if (row.status === "rejected") {
      if (!state.everConfirmed) {
        // never crossed the gate → could never have been exported → nothing.
        omit(OMISSION.rejectedNeverConfirmed);
        continue;
      }
      tombstones.push({
        originNoteId: row.id,
        textHash: row.textHash,
        reason: row.supersededBy ? "superseded" : "revoked",
        supersededByNoteId: row.supersededBy ?? null,
        retiredAt: (row.retiredAt ?? row.updatedAt).toISOString(),
      });
      continue;
    }
    if (!state.confirmedNow || !state.latestConfirm) {
      omit(OMISSION.notConfirmed);
      continue;
    }
    // Redact BEFORE anything is hashed or serialized; then the size gate.
    // BOTH redactions, and the content address is computed over the RESULT — so
    // the importer re-running `redactForPack` must reproduce this byte for byte
    // (see `verifyRecord`). Secrets alone were not enough: absolute paths and
    // machine-local hostnames rode a pack verbatim until a security review
    // exported one.
    const text = redactForPack(row.text);
    if (text.length > MEMORY_PACK_MAX_TEXT_CHARS) {
      omit(OMISSION.oversize); // omit, never truncate (see module header)
      continue;
    }
    const noteTextHash = computeMemoryTextHash(text);
    const record: MemoryPackRecord = {
      version: MEMORY_PACK_VERSION,
      origin: {
        fingerprint: source.origin.fingerprint,
        noteId: row.id,
        label: source.origin.label,
      },
      note: {
        kind: row.kind,
        text,
        textHash: noteTextHash,
        scope: row.scope,
        trust: row.trust,
        modules: sortedUnique(asStringArray(row.modules)),
        topics: sortedUnique(asStringArray(row.topics)),
        symbols: sortedUnique(asStringArray(row.symbols)),
        validFrom: row.validFrom.toISOString(),
        recordedAt: row.recordedAt.toISOString(),
      },
      author: {
        principal: row.createdBy,
        kind: isHumanPrincipal(row.createdBy) ? "human" : "agent",
      },
      confirmation: {
        principal: state.latestConfirm.principal,
        decision: "confirm",
        at: state.latestConfirm.at.toISOString(),
        textHash: noteTextHash,
      },
      supersededTextHashes: supersededHashesFor(row.id),
    };
    records.push({ hash: recordHashOf(record), record, chars: text.length });
  }

  records.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  tombstones.sort((a, b) =>
    a.originNoteId < b.originNoteId ? -1 : a.originNoteId > b.originNoteId ? 1 : 0
  );
  const omitted = [...omissionCounts.values()].reduce((sum, n) => sum + n, 0);
  const omissions = [...omissionCounts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([reason, count]) => `${count} note${count === 1 ? "" : "s"} excluded: ${reason}`);

  const slices = paginate(records, tombstones);
  const pageCount = slices.length;
  return slices.map((slice, page) =>
    assemblePage(source.origin, slice.records, slice.tombstones, omissions, omitted, {
      page,
      pageCount,
      totalRecords: records.length,
      totalTombstones: tombstones.length,
    })
  );
}

// ── ledger-direct collector ──────────────────────────────────────────────────

async function collectPackSource(
  workspacePath: string,
  opts: { dataDir?: string }
): Promise<MemoryPackSource> {
  // ADR-0026 §7: the `Task` join that used to compute the boundary is GONE, not
  // merely unused. `MemoryNote.workspacePath` is the partition, so a second
  // derivation of it here would be a second answer to one question — and the query
  // it removes was the fail-open one (a pruned Task row read as "in-workspace").
  const [notes, confirmations] = await Promise.all([
    prisma.memoryNote.findMany({ orderBy: { id: "asc" } }),
    prisma.confirmation.findMany({ orderBy: [{ at: "asc" }, { id: "asc" }] }),
  ]);
  return {
    workspacePath,
    origin: {
      fingerprint: workspaceFingerprint(workspacePath, opts.dataDir),
      label: path.basename(workspacePath),
    },
    notes,
    confirmations,
  };
}

/**
 * Read the ledger (NOT /library — that read truncates at 200 rows) and build
 * the pack for a workspace path that the caller has already VALIDATED
 * (`validateWorkspacePath`) and REDUCED (`repoRootOf`). Read-only: no ledger
 * writes, no graph access, no reinforcement.
 *
 * ADR-0026 §7: that reduction is now load-bearing rather than cosmetic. The
 * boundary compares the caller's string against the stored partition, so an
 * unreduced worktree path or case-variant spelling would match NOTHING and export
 * an empty (but honestly-counted) pack. Fail-closed, so not a leak — and wrong.
 *
 * `opts.page` selects which page of a paged export to return (default 0). A
 * workspace that fits in one pack is a single page (`counts.pageCount === 1`);
 * a 501+-note (or high-volume) brain splits deterministically and the caller
 * pages via `counts.pageCount` / `collectMemoryPackPages` — no dead-end.
 */
export async function collectMemoryPack(
  workspacePath: string,
  opts: { dataDir?: string; page?: number } = {}
): Promise<MemoryPackExport> {
  const source = await collectPackSource(workspacePath, opts);
  return buildMemoryPack(source, { page: opts.page });
}

/** Every importable page of the workspace's export, in order. */
export async function collectMemoryPackPages(
  workspacePath: string,
  opts: { dataDir?: string } = {}
): Promise<MemoryPackExport[]> {
  const source = await collectPackSource(workspacePath, opts);
  return buildMemoryPackPages(source);
}
