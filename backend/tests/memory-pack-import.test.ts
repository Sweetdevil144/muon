import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { selectMemorySliceNotes } from "@muon/core";

// P1.4 Slice 2 — memory pack IMPORT as proposals (backend/src/lib/memory-pack-import.ts).
//
// The confirmed-only moat is SACRED: no incoming record ever enters the
// trusted/confirmed set without a fresh human confirmation in the RECEIVING
// workspace. These tests encode that structurally:
//   - an imported record lands ACTIVE + UNCONFIRMED (zero Confirmation rows),
//     trust "low", createdBy "pack:<fp>", full origin provenance in MemoryImport;
//   - it is invisible to agent slices until the EXISTING human confirm flow
//     blesses it locally (confirm flow untouched);
//   - re-import is idempotent via (originWorkspace, recordHash), even anchor-less;
//   - a textHash duplicate of a locally CONFIRMED note is a no-op;
//   - collisions run the existing conflict machinery NON-destructively
//     (proposalOnly: an import can retire nothing);
//   - tombstones propagate revocation as a set-once STALE review item, never a
//     retire; a human re-confirm clears it.

// SPREAD THE ACTUAL MODULE, then override only the three the pack path must not
// really do. An ENUMERATING mock is a drift surface: it lists the exports the
// module had on the day it was written, so the next export added to `graph.js`
// fails these tests with "No X export is defined on the mock" — which is what
// happened when the confirm path started draining in-flight mirrors. Spreading
// keeps every function the mock does not care about real, and a no-op
// `mirrorToGraph` means nothing is ever enqueued, so the real drain is a no-op too.
vi.mock("../src/lib/graph.js", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/graph.js")>(
    "../src/lib/graph.js"
  )),
  getGraph: () => ({}),
  getEmbedder: () => null,
  mirrorToGraph: () => undefined,
}));

type Db = typeof import("../src/lib/db.js");
type Ledger = typeof import("../src/lib/memory-ledger.js");
type PackLib = typeof import("../src/lib/memory-pack.js");
type ImportLib = typeof import("../src/lib/memory-pack-import.js");

let prisma: Db["prisma"];
let ledger: Ledger;
let packLib: PackLib;
let importLib: ImportLib;
let dataDir: string;

const ORIGIN_FP = "ws-00000000000000aa";
const ORIGIN_LABEL = "teammate-repo";
const T_CONFIRM = "2026-07-02T10:00:00.000Z";
const T_RETIRED = "2026-07-05T10:00:00.000Z";

type RecordSpec = {
  noteId: string;
  text: string;
  kind?: string;
  modules?: string[];
  topics?: string[];
  symbols?: string[];
  trust?: string;
  author?: string;
  confirmedBy?: string;
};

function makeRecord(spec: RecordSpec) {
  const textHash = ledger.computeMemoryTextHash(spec.text);
  const record = {
    version: 1 as const,
    origin: { fingerprint: ORIGIN_FP, noteId: spec.noteId, label: ORIGIN_LABEL },
    note: {
      kind: spec.kind ?? "constraint",
      text: spec.text,
      textHash,
      scope: "project",
      trust: spec.trust ?? "high",
      modules: [...(spec.modules ?? [])].sort(),
      topics: [...(spec.topics ?? [])].sort(),
      symbols: [...(spec.symbols ?? [])].sort(),
      validFrom: "2026-07-01T10:00:00.000Z",
      recordedAt: "2026-07-01T10:00:00.000Z",
    },
    author: { principal: spec.author ?? "human:carol", kind: "human" as const },
    confirmation: {
      principal: spec.confirmedBy ?? "human:carol",
      decision: "confirm" as const,
      at: T_CONFIRM,
      textHash,
    },
    supersededTextHashes: [],
  };
  return { hash: packLib.recordHashOf(record), record };
}

type Tombstone = {
  originNoteId: string;
  textHash: string;
  reason: "superseded" | "revoked";
  supersededByNoteId: string | null;
  retiredAt: string;
};

function makePack(
  records: { hash: string; record: ReturnType<typeof makeRecord>["record"] }[],
  tombstones: Tombstone[] = []
) {
  const sorted = [...records].sort((a, b) => (a.hash < b.hash ? -1 : 1));
  const sortedTombs = [...tombstones].sort((a, b) =>
    a.originNoteId < b.originNoteId ? -1 : 1
  );
  const manifestCore = {
    version: 1 as const,
    origin: { fingerprint: ORIGIN_FP, label: ORIGIN_LABEL },
    records: sorted.map(({ hash, record }) => ({
      hash,
      file: `records/${hash}.json`,
      originNoteId: record.origin.noteId,
      textHash: record.note.textHash,
    })),
    tombstones: sortedTombs,
  };
  return {
    manifest: {
      version: 1 as const,
      origin: manifestCore.origin,
      counts: {
        records: sorted.length,
        tombstones: sortedTombs.length,
        omitted: 0,
      },
      records: manifestCore.records,
      tombstones: sortedTombs,
      omissions: [],
      invariants: {
        confirmedOnly: true,
        unconfirmedTextExcluded: true,
        secretsRedactedBeforeWrite: true,
        noCredentialMaterial: true,
      },
      packDigest: packLib.packDigestOf(manifestCore),
    },
    records: sorted,
  };
}

function expectOk(
  result: Awaited<ReturnType<ImportLib["importMemoryPack"]>>
): Extract<Awaited<ReturnType<ImportLib["importMemoryPack"]>>, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected ok import, refused: ${result.reason}`);
  }
  return result;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "muon-pack-import-"));
  mkdirSync(path.join(dataDir, "repo"), { recursive: true });
  process.env.DATABASE_URL = `file:${path.join(dataDir, "muon.db")}`;
  process.env.MUON_DATA_DIR = dataDir;
  vi.resetModules();
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();
  ledger = await import("../src/lib/memory-ledger.js");
  packLib = await import("../src/lib/memory-pack.js");
  importLib = await import("../src/lib/memory-pack-import.js");
});

afterAll(async () => {
  await prisma?.$disconnect();
  delete process.env.MUON_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("memory pack import (P1.4 slice 2)", () => {
  it("lands an imported record as an ACTIVE, UNCONFIRMED, low-trust proposal with full provenance", async () => {
    const rec = makeRecord({
      noteId: "mem-origin-basic",
      text: "Always run the schema linter before a prisma migration.",
      modules: ["backend/prisma/schema.prisma"],
      topics: ["migrations"],
      symbols: ["backend/src/lib/db.ts#ensureSchema"],
    });
    const result = expectOk(await importLib.importMemoryPack(makePack([rec])));
    expect(result.report.origin).toEqual({
      fingerprint: ORIGIN_FP,
      label: ORIGIN_LABEL,
    });
    expect(result.report.proposed).toHaveLength(1);
    expect(result.report.proposed[0].recordHash).toBe(rec.hash);
    const noteId = result.report.proposed[0].noteId;

    const row = await prisma.memoryNote.findUnique({ where: { id: noteId } });
    expect(row?.status).toBe("active");
    expect(row?.trust).toBe("low");
    expect(row?.createdBy).toBe(`pack:${ORIGIN_FP}`);
    expect(row?.modules).toContain("backend/prisma/schema.prisma");
    expect(row?.topics).toContain("migrations");
    expect(row?.symbols).toContain("backend/src/lib/db.ts#ensureSchema");
    // Structurally unconfirmed: the import wrote ZERO Confirmation rows.
    expect(await prisma.confirmation.count({ where: { noteId } })).toBe(0);
    const note = await ledger.getMemoryNote(noteId);
    expect(note?.confirmed).toBe(false);

    // Full origin provenance in MemoryImport — DATA, never authority.
    const imported = await prisma.memoryImport.findUnique({
      where: {
        // ADR-0026 §7 widened the idempotence key to include the RECEIVING
        // workspace. These imports name none (this file is about the hostile-pack
        // verifier, not the partition), so it holds its '' default and addresses
        // the identical row it always did — see `memory-pack-workspace.test.ts`
        // for the stamped-partition behaviour.
        originWorkspace_receivingWorkspace_recordHash: {
          originWorkspace: ORIGIN_FP,
          receivingWorkspace: "",
          recordHash: rec.hash,
        },
      },
    });
    expect(imported).toMatchObject({
      originWorkspace: ORIGIN_FP,
      originLabel: ORIGIN_LABEL,
      originNoteId: "mem-origin-basic",
      recordHash: rec.hash,
      textHash: rec.record.note.textHash,
      noteId,
      disposition: "proposed",
      originAuthor: "human:carol",
      originConfirmedBy: "human:carol",
    });
    expect(imported?.originConfirmedAt.toISOString()).toBe(T_CONFIRM);
  });

  it("keeps the imported note invisible to agent slices until the EXISTING local human confirm admits it", async () => {
    const rec = makeRecord({
      noteId: "mem-origin-gate",
      text: "Gate check: pack proposals stay out of agent slices.",
      modules: ["backend/src/lib/gate-check-module.ts"],
    });
    const result = expectOk(await importLib.importMemoryPack(makePack([rec])));
    const noteId = result.report.proposed[0].noteId;

    const before = await ledger.getMemoryNote(noteId);
    expect(before).not.toBeNull();
    // The agent slice selector (confirmed && !stale) excludes it.
    expect(selectMemorySliceNotes([before!])).toEqual([]);

    // The EXISTING PATCH confirm flow (byte-identical shape) admits it.
    const after = await ledger.updateMemoryNote(noteId, {
      confirmed: true,
      principal: "human:dana",
    });
    expect(after?.confirmed).toBe(true);
    expect(selectMemorySliceNotes([after!])).toHaveLength(1);
    // The blessing is LOCAL: recorded by the receiving human, not the origin.
    const confirmations = await prisma.confirmation.findMany({
      where: { noteId },
    });
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].principal).toBe("human:dana");
  });

  it("re-import of the same pack is idempotent via (originWorkspace, recordHash), including anchor-less records", async () => {
    const anchored = makeRecord({
      noteId: "mem-origin-idem-a",
      text: "Idempotence check for anchored records.",
      modules: ["backend/src/lib/idem-module.ts"],
    });
    // NO modules/topics/symbols — the ledger's anchor dedup can never see it,
    // so only the (originWorkspace, recordHash) key can dedup it.
    const anchorless = makeRecord({
      noteId: "mem-origin-idem-b",
      text: "Idempotence check for a record with no anchors at all.",
    });
    const pack = makePack([anchored, anchorless]);
    const first = expectOk(await importLib.importMemoryPack(pack));
    expect(first.report.proposed).toHaveLength(2);
    const countAfterFirst = await prisma.memoryNote.count();

    const second = expectOk(await importLib.importMemoryPack(pack));
    expect(second.report.proposed).toHaveLength(0);
    expect([...second.report.alreadyImported].sort()).toEqual(
      [anchored.hash, anchorless.hash].sort()
    );
    expect(await prisma.memoryNote.count()).toBe(countAfterFirst);
  });

  it("a record whose textHash matches a locally HUMAN-confirmed active note is a no-op (duplicate-confirmed)", async () => {
    const text = "The deploy pipeline must never skip the smoke test.";
    // Seed the SAME fact locally, human-confirmed.
    const local = await ledger.ingestMemoryNote({
      kind: "constraint",
      text,
      modules: ["ops/deploy-pipeline.ts"],
      createdBy: "human:erin",
    });
    await ledger.updateMemoryNote(local.note.id, {
      confirmed: true,
      principal: "human:erin",
    });
    await ledger.updateMemoryNote(local.note.id, {
      pinned: true,
      principal: "human:erin",
    });

    const rec = makeRecord({
      noteId: "mem-origin-dup",
      text,
      modules: ["ops/deploy-pipeline.ts"],
    });
    const before = await prisma.memoryNote.count();
    const result = expectOk(await importLib.importMemoryPack(makePack([rec])));
    expect(result.report.duplicatesOfConfirmed).toEqual([
      { recordHash: rec.hash, noteId: local.note.id },
    ]);
    expect(result.report.proposed).toHaveLength(0);
    expect(await prisma.memoryNote.count()).toBe(before);
    const imported = await prisma.memoryImport.findUnique({
      where: {
        // ADR-0026 §7 widened the idempotence key to include the RECEIVING
        // workspace. These imports name none (this file is about the hostile-pack
        // verifier, not the partition), so it holds its '' default and addresses
        // the identical row it always did — see `memory-pack-workspace.test.ts`
        // for the stamped-partition behaviour.
        originWorkspace_receivingWorkspace_recordHash: {
          originWorkspace: ORIGIN_FP,
          receivingWorkspace: "",
          recordHash: rec.hash,
        },
      },
    });
    expect(imported?.disposition).toBe("duplicate-confirmed");
    expect(imported?.noteId).toBe(local.note.id);
  });

  it("does not let a paused local fact swallow the same incoming proposal", async () => {
    const text = "A paused local decision must not suppress teammate evidence.";
    const local = await ledger.ingestMemoryNote({
      kind: "constraint",
      text,
      modules: ["ops/paused-import.ts"],
      createdBy: "human:operator",
    });
    await ledger.updateMemoryNote(local.note.id, {
      confirmed: true,
      principal: "human:operator",
    });
    await ledger.updateMemoryNote(local.note.id, { status: "paused" });

    const rec = makeRecord({
      noteId: "mem-origin-paused-boundary",
      text,
      modules: ["ops/paused-import.ts"],
    });
    const result = expectOk(await importLib.importMemoryPack(makePack([rec])));
    expect(result.report.duplicatesOfConfirmed).toEqual([]);
    expect(result.report.proposed).toHaveLength(1);
    expect(result.report.proposed[0]!.noteId).not.toBe(local.note.id);
    expect(
      await prisma.memoryNote.findUnique({
        where: { id: result.report.proposed[0]!.noteId },
      })
    ).toMatchObject({ status: "active", trust: "low" });
    expect(
      await prisma.confirmation.count({
        where: { noteId: result.report.proposed[0]!.noteId },
      })
    ).toBe(0);
  });

  it("collisions run the existing conflict machinery NON-destructively; report arrays are sorted", async () => {
    // Opposite-polarity same-kind note on a shared module → conflict verdict.
    const conflictVictim = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "always use the retry helper for network calls in the fetcher module",
      modules: ["src/net/fetcher.ts"],
      createdBy: "human:frank",
    });
    // Higher-trust UNCONFIRMED note on a shared module, similar same-polarity
    // text → supersede verdict, degraded to proposes_supersede (import is never
    // authorized).
    const proposeVictim = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "use the request signer for outbound api calls in the uplink module",
      modules: ["src/net/uplink.ts"],
      trust: "high",
      createdBy: "human:frank",
    });

    const conflictRec = makeRecord({
      noteId: "mem-origin-conflict",
      text: "never use the retry helper for network calls in the fetcher module",
      modules: ["src/net/fetcher.ts"],
    });
    const proposeRec = makeRecord({
      noteId: "mem-origin-propose",
      text: "use the request signer for outbound api requests in the uplink module",
      modules: ["src/net/uplink.ts"],
    });
    const result = expectOk(
      await importLib.importMemoryPack(makePack([conflictRec, proposeRec]))
    );

    // BOTH new notes land active; BOTH victims remain active (nothing retired).
    expect(result.report.proposed).toHaveLength(2);
    const victims = await prisma.memoryNote.findMany({
      where: { id: { in: [conflictVictim.note.id, proposeVictim.note.id] } },
    });
    expect(victims.every((v) => v.status === "active")).toBe(true);

    const kinds = result.report.conflicts.map((c) => c.edgeKind).sort();
    expect(kinds).toEqual(["contradicts", "proposes_supersede"]);
    const contradiction = result.report.conflicts.find(
      (c) => c.edgeKind === "contradicts"
    );
    expect(contradiction?.withNoteId).toBe(conflictVictim.note.id);
    const proposal = result.report.conflicts.find(
      (c) => c.edgeKind === "proposes_supersede"
    );
    expect(proposal?.withNoteId).toBe(proposeVictim.note.id);
    // Deterministic review: arrays sorted (proposed by recordHash, conflicts by noteId).
    const hashes = result.report.proposed.map((p) => p.recordHash);
    expect(hashes).toEqual([...hashes].sort());
    const conflictIds = result.report.conflicts.map((c) => c.noteId);
    expect(conflictIds).toEqual([...conflictIds].sort());
    // The ledger holds the durable proposal edge.
    const edge = await prisma.memoryEdge.findFirst({
      where: { toId: proposeVictim.note.id, kind: "proposes_supersede" },
    });
    expect(edge).not.toBeNull();
  });

  it("proposalOnly: an import can retire NOTHING (low-trust unconfirmed victim survives); plain ingest is unchanged", async () => {
    // Victim: unconfirmed, trust LOW — WITHOUT proposalOnly a low-trust writer
    // would be authorized to supersede it.
    const victim = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "use the retry helper for network calls in the sync module",
      modules: ["src/net/sync.ts"],
      trust: "low",
      createdBy: "agent:codex",
    });

    const rec = makeRecord({
      noteId: "mem-origin-proposalonly",
      text: "use the retry helper for network requests in the sync module",
      modules: ["src/net/sync.ts"],
    });
    expectOk(await importLib.importMemoryPack(makePack([rec])));
    const afterImport = await prisma.memoryNote.findUnique({
      where: { id: victim.note.id },
    });
    expect(afterImport?.status).toBe("active"); // NOT retired by the import

    // Golden regression: the SAME shape WITHOUT proposalOnly still supersedes.
    const goldenVictim = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "use the retry helper for network calls in the golden module",
      modules: ["src/net/golden.ts"],
      trust: "low",
      createdBy: "agent:codex",
    });
    const golden = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "use the retry helper for network requests in the golden module",
      modules: ["src/net/golden.ts"],
      trust: "low",
      createdBy: "agent:codex",
    });
    expect(golden.action).toBe("superseded");
    const goldenRow = await prisma.memoryNote.findUnique({
      where: { id: goldenVictim.note.id },
    });
    expect(goldenRow?.status).toBe("rejected");
    expect(goldenRow?.supersededBy).toBe(golden.note.id);
  });

  it("tombstones propagate revocation as a SET-ONCE stale review item, never a retire; human re-confirm clears it", async () => {
    const rec = makeRecord({
      noteId: "mem-origin-revoked",
      text: "Cache invalidation runs on every write to the settings store.",
      modules: ["src/settings/store.ts"],
    });
    const imported = expectOk(await importLib.importMemoryPack(makePack([rec])));
    const noteId = imported.report.proposed[0].noteId;
    // Receiving human confirms it locally — it is now in agent slices.
    await ledger.updateMemoryNote(noteId, {
      confirmed: true,
      principal: "human:gina",
    });

    const tombstone: Tombstone = {
      originNoteId: "mem-origin-revoked",
      textHash: rec.record.note.textHash,
      reason: "revoked",
      supersededByNoteId: null,
      retiredAt: T_RETIRED,
    };
    const revokePack = makePack([], [tombstone]);
    const revoked = expectOk(await importLib.importMemoryPack(revokePack));
    expect(revoked.report.revocations).toEqual([
      { noteId, originNoteId: "mem-origin-revoked", reason: "revoked" },
    ]);

    const row = await prisma.memoryNote.findUnique({ where: { id: noteId } });
    expect(row?.status).toBe("active"); // NEVER auto-retired
    expect(row?.staleSince?.toISOString()).toBe(T_RETIRED);
    // Flagged for review via the system reconcile marker (inert to the gate).
    const reconciles = await prisma.confirmation.count({
      where: { noteId, decision: "reconcile" },
    });
    expect(reconciles).toBe(1);
    // D9-ii: stale stays in agent slices as demoted (still confirmed).
    const staleNote = await ledger.getMemoryNote(noteId);
    expect(staleNote?.confirmed).toBe(true);
    expect(staleNote?.stale).toBe(true);
    expect(selectMemorySliceNotes([staleNote!])).toHaveLength(1);
    // Disposition upgraded to revoked-at-origin.
    const importRow = await prisma.memoryImport.findFirst({
      where: { originWorkspace: ORIGIN_FP, originNoteId: "mem-origin-revoked" },
    });
    expect(importRow?.disposition).toBe("revoked-at-origin");

    // Second import: SET-ONCE no-op — no new reconcile row, no new revocation.
    const again = expectOk(await importLib.importMemoryPack(revokePack));
    expect(again.report.revocations).toEqual([]);
    expect(
      await prisma.confirmation.count({ where: { noteId, decision: "reconcile" } })
    ).toBe(1);
    const rowAgain = await prisma.memoryNote.findUnique({ where: { id: noteId } });
    expect(rowAgain?.staleSince?.toISOString()).toBe(T_RETIRED);

    // A tombstone for a never-imported/foreign origin note touches nothing.
    const foreignPack = makePack(
      [],
      [
        {
          originNoteId: "mem-origin-never-imported",
          textHash: "e".repeat(64),
          reason: "revoked",
          supersededByNoteId: null,
          retiredAt: T_RETIRED,
        },
      ]
    );
    const foreign = expectOk(await importLib.importMemoryPack(foreignPack));
    expect(foreign.report.revocations).toEqual([]);

    // Human re-confirm clears staleness → back into agent slices.
    const reconfirmed = await ledger.updateMemoryNote(noteId, {
      confirmed: true,
      principal: "human:gina",
    });
    expect(reconfirmed?.staleSince).toBeNull();
    expect(selectMemorySliceNotes([reconfirmed!])).toHaveLength(1);
  });

  // SEC-2 (confirmed-only-moat authority inversion): a foreign pack must NEVER
  // be able to stale a purely-LOCAL human-confirmed note. The attacker crafts a
  // record whose text matches a local confirmed note L (→ duplicate-confirmed
  // branch, which used to write a provenance row linking the attacker's
  // originNoteId to L.id) PLUS a tombstone for that same originNoteId. The
  // tombstone loop must not reach L: tombstone revocation is confined to notes
  // that ORIGINATED as imported proposals, never a local, never-imported,
  // human-confirmed memory.
  it("SEC-2: a pack whose record text matches a LOCAL confirmed note + a tombstone for it does NOT stale the local note", async () => {
    const text =
      "Local invariant sec2: the confirmed-only moat is sacred and unforgeable.";
    const local = await ledger.ingestMemoryNote({
      kind: "constraint",
      text,
      modules: ["src/sec2-moat.ts"],
      createdBy: "human:owner",
    });
    await ledger.updateMemoryNote(local.note.id, {
      confirmed: true,
      principal: "human:owner",
    });
    const before = await prisma.memoryNote.findUnique({
      where: { id: local.note.id },
    });
    expect(before?.staleSince).toBeNull();
    expect(before?.status).toBe("active");

    const rec = makeRecord({
      noteId: "mem-attacker-sec2",
      text,
      modules: ["src/sec2-moat.ts"],
    });
    const tombstone: Tombstone = {
      originNoteId: "mem-attacker-sec2",
      textHash: rec.record.note.textHash,
      reason: "revoked",
      supersededByNoteId: null,
      retiredAt: T_RETIRED,
    };
    const result = expectOk(
      await importLib.importMemoryPack(makePack([rec], [tombstone]))
    );
    // The record dedups to the local confirmed note (no new proposal).
    expect(result.report.duplicatesOfConfirmed).toEqual([
      { recordHash: rec.hash, noteId: local.note.id },
    ]);
    // The tombstone reaches NOTHING: the local note never originated as an
    // imported proposal, so it is not revocable by a foreign pack.
    expect(result.report.revocations).toEqual([]);
    const after = await prisma.memoryNote.findUnique({
      where: { id: local.note.id },
    });
    expect(after?.staleSince).toBeNull(); // NOT staled by the foreign pack
    expect(after?.status).toBe("active");
    const note = await ledger.getMemoryNote(local.note.id);
    expect(note?.confirmed).toBe(true);
    // Still visible in agent slices — the moat held.
    expect(selectMemorySliceNotes([note!])).toHaveLength(1);
  });

  // SEC-2 (RESIDUAL — disposition-flip): the FIRST SEC-2 fix confined the tombstone
  // BATCHED MATCH by disposition, but the revocation disposition-FLIP still rewrote
  // EVERY (originWorkspace, originNoteId) row — including the `duplicate-confirmed`
  // marker that points at a LOCAL confirmed note L. A hostile pack defeats that with
  // ONE decoy + a 2nd re-sync: record A (text == L → duplicate-confirmed, its
  // MemoryImport row points at L.id) plus a decoy record B sharing origin.noteId,
  // which lands as its OWN imported proposal P, plus a tombstone for that shared
  // origin note id. Import#1 stales the decoy P and — with the residual bug — flips
  // A's protective marker to `revoked-at-origin`; Import#2's batched match then finds
  // A un-excluded (noteId == L) and stales L. Tombstones are NOT idempotency-tracked,
  // so a NORMAL 2nd sync re-fires the tombstone. L MUST stay active after BOTH imports.
  it("SEC-2 (residual): a decoy proposal sharing an origin note id + a 2nd re-sync does NOT stale the LOCAL confirmed note", async () => {
    const sharedOriginNoteId = "mem-attacker-sec2-residual";
    const text =
      "Local invariant sec2-residual: the confirmed-only moat survives a decoy plus a re-sync.";
    const local = await ledger.ingestMemoryNote({
      kind: "constraint",
      text,
      modules: ["src/sec2-residual-moat.ts"],
      createdBy: "human:owner",
    });
    await ledger.updateMemoryNote(local.note.id, {
      confirmed: true,
      principal: "human:owner",
    });

    // Record A: text == L → duplicate-confirmed; its MemoryImport row points at L.id.
    const dupRec = makeRecord({
      noteId: sharedOriginNoteId,
      text,
      modules: ["src/sec2-residual-moat.ts"],
    });
    // Record B: a NOVEL decoy sharing the SAME origin.noteId → lands as its own fresh
    // imported proposal P. Anchorless so it never dedups: a plain `proposed`.
    const decoyRec = makeRecord({
      noteId: sharedOriginNoteId,
      text: "sec2-residual decoy proposal that lands as its own imported note P",
    });
    const tombstone: Tombstone = {
      originNoteId: sharedOriginNoteId,
      textHash: dupRec.record.note.textHash,
      reason: "revoked",
      supersededByNoteId: null,
      retiredAt: T_RETIRED,
    };
    const pack = makePack([dupRec, decoyRec], [tombstone]);

    // ── Import #1: the decoy lands, the tombstone stales the DECOY (never L) ─────
    const first = expectOk(await importLib.importMemoryPack(pack));
    expect(first.report.duplicatesOfConfirmed).toEqual([
      { recordHash: dupRec.hash, noteId: local.note.id },
    ]);
    expect(first.report.proposed).toHaveLength(1);
    const decoyNoteId = first.report.proposed[0].noteId;
    expect(decoyNoteId).not.toBe(local.note.id);
    // The tombstone reaches the imported proposal P — never the local confirmed L.
    expect(first.report.revocations).toEqual([
      { noteId: decoyNoteId, originNoteId: sharedOriginNoteId, reason: "revoked" },
    ]);
    const decoyAfter1 = await prisma.memoryNote.findUnique({
      where: { id: decoyNoteId },
    });
    expect(decoyAfter1?.staleSince?.toISOString()).toBe(T_RETIRED);
    const localAfter1 = await prisma.memoryNote.findUnique({
      where: { id: local.note.id },
    });
    expect(localAfter1?.staleSince).toBeNull();
    expect(localAfter1?.status).toBe("active");

    // ── Import #2: a NORMAL re-sync (tombstones re-fire; not idempotency-tracked) ─
    const second = expectOk(await importLib.importMemoryPack(pack));
    expect([...second.report.alreadyImported].sort()).toEqual(
      [dupRec.hash, decoyRec.hash].sort()
    );
    // THE MOAT: L is STILL active and unstaled after the second sync — the flip can
    // never have rewritten A's `duplicate-confirmed` marker, so the batched match
    // never picks L up.
    const localAfter2 = await prisma.memoryNote.findUnique({
      where: { id: local.note.id },
    });
    expect(localAfter2?.staleSince).toBeNull();
    expect(localAfter2?.status).toBe("active");
    const note = await ledger.getMemoryNote(local.note.id);
    expect(note?.confirmed).toBe(true);
    expect(selectMemorySliceNotes([note!])).toHaveLength(1);
  });

  // SEC-4: an aggregate redaction-char budget bounds how much quadratic
  // redactSecrets work one import can force onto the event loop. Overflow
  // records are refused with a stated reason (fail-closed), honest earlier
  // records still import, and every record is accounted for in the report.
  it("SEC-4: an import cannot exceed the aggregate redaction budget; overflow refused with a reason", async () => {
    const CHARS = 10_000;
    const N = 60; // 60 * ~10k ≈ 600k > the 500k budget
    const recs = Array.from({ length: N }, (_, i) =>
      makeRecord({
        noteId: `mem-budget-${i}`,
        // unique + anchorless → each is a plain new proposal (no dedup NOOP).
        text: `budget-${i} ${"a".repeat(CHARS - 20)}`,
      })
    );
    const result = expectOk(await importLib.importMemoryPack(makePack(recs)));
    const budgetRefusals = result.report.refused.filter((r) =>
      /redaction budget/.test(r.reason)
    );
    expect(budgetRefusals.length).toBeGreaterThan(0);
    // Nothing is lost: every record is either proposed or refused, exactly once.
    expect(result.report.counts.proposed + result.report.counts.refused).toBe(N);
    // The under-budget prefix DID import.
    expect(result.report.counts.proposed).toBeGreaterThan(0);
  }, 60_000);

  // CODE-G: the tombstone array is bounded (was unbounded → ~10^5 sequential DB
  // round-trips per 16 MB request). Over-cap → whole pack refused.
  it("CODE-G: a pack carrying more than the tombstone cap is refused whole", async () => {
    const many: Tombstone[] = Array.from({ length: 501 }, (_, i) => ({
      originNoteId: `tomb-${i}`,
      textHash: "a".repeat(64),
      reason: "revoked",
      supersededByNoteId: null,
      retiredAt: T_RETIRED,
    }));
    const result = await importLib.importMemoryPack(makePack([], many));
    expect(result.ok).toBe(false);
  });

  // CODE-H: pack record anchor arrays are capped like the direct-create route,
  // so a self-consistent record can't smuggle a huge IN(...) into SQLite. The
  // over-cap record is refused record-level; its honest sibling still imports.
  it("CODE-H: a record with an over-cap anchor array is refused; honest sibling imports", async () => {
    const honest = makeRecord({
      noteId: "mem-anchor-ok",
      text: "honest anchor sibling that must still import",
    });
    const evil = makeRecord({
      noteId: "mem-anchor-evil",
      text: "evil record with a giant symbols array",
      symbols: Array.from({ length: 200 }, (_, i) => `mod#sym${i}`),
    });
    const result = expectOk(
      await importLib.importMemoryPack(makePack([honest, evil]))
    );
    expect(result.report.proposed.map((p) => p.recordHash)).toContain(honest.hash);
    expect(result.report.refused.map((r) => r.recordHash)).toContain(evil.hash);
  });

  // CODE-D: idempotence-row-FIRST. Two concurrent identical imports of an
  // ANCHOR-LESS record (which the ledger's anchor dedup can never catch) must
  // insert exactly ONE note — the unique (originWorkspace, recordHash) claim is
  // the gate, so no orphan proposal forms and no record is double-counted.
  it("CODE-D: concurrent duplicate import of an anchorless record inserts exactly one note (no orphan/double-count)", async () => {
    const rec = makeRecord({
      noteId: "mem-concur-idem",
      text: "concurrent anchorless idempotence, no shared anchor to dedup on",
    });
    const pack = makePack([rec]);
    const before = await prisma.memoryNote.count();
    const [a, b] = await Promise.all([
      importLib.importMemoryPack(pack),
      importLib.importMemoryPack(pack),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      const proposedTotal =
        a.report.counts.proposed + b.report.counts.proposed;
      const alreadyTotal =
        a.report.counts.alreadyImported + b.report.counts.alreadyImported;
      expect(proposedTotal).toBe(1); // exactly one ingest across both
      expect(alreadyTotal).toBe(1); // the loser deduped on the claim
    }
    expect(await prisma.memoryNote.count()).toBe(before + 1); // no orphan
    // No claim is ever left in the transient "pending" state.
    expect(
      await prisma.memoryImport.count({ where: { disposition: "pending" } })
    ).toBe(0);
  });
});
